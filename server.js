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

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALUES = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };


const GameMode = {
    CLASSIC: {
        name: '🎯 Классика',
        fullDeck: false,
        fixedRounds: 11,
        cardPattern: 'ascending_descending',
        hasBidding: true  // ✅ ТОРГОВЛЯ ЕСТЬ
    },
    MISER: {
        name: '😈 Мизер',
        fullDeck: true,
        fixedRounds: null,
        cardPattern: 'equal_distribution',
        hasBidding: false,  // ❌ НЕТ ТОРГОВЛИ
        autoBid: 0
    },
    NO_TRUMP: {
        name: '🃏 Бескозырка',
        fullDeck: true,
        fixedRounds: null,
        cardPattern: 'equal_distribution',
        hasBidding: true  // ✅ ТОРГОВЛЯ ЕСТЬ
    },
    BLIND: {
        name: '👁️ Слепая',
        fullDeck: true,
        fixedRounds: null,
        cardPattern: 'equal_distribution',
        hasBidding: true  // ✅ ТОРГОВЛЯ ЕСТЬ
    },
    KHAPKI: {
        name: '🔥 Хапки',
        fullDeck: true,
        fixedRounds: null,
        cardPattern: 'equal_distribution',
        hasBidding: false,  // ❌ НЕТ ТОРГОВЛИ
        autoBid: null
    }
};

const CAMPAIGN_MODES = [
    GameMode.CLASSIC,
    GameMode.MISER,
    GameMode.NO_TRUMP,
    GameMode.BLIND,
    GameMode.KHAPKI
];

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
        this.dealtHistory = []; // История выданных карт
        this.maxHistory = 20;   // Размер истории для балансировки
        this.baseFrequency = 1; // Базовый вес
        this.boostFactor = 1.5; // Множитель усиления "забытых" карт
        this.penaltyFactor = 0.7; // Множитель ослабления "частых" карт

        this.createDeck();
    }

    createDeck() {
        this.cards = [];
        this.frequencies = [];
        this.dealtHistory = [];

        for (let suit of SUITS) {
            for (let rank of RANKS) {
                const isSixSpades = (suit === '♠' && rank === '6');
                const card = new Card(suit, rank, isSixSpades);
                this.cards.push(card);
                this.frequencies.push(this.baseFrequency);
            }
        }
        this.shuffle();
    }

    /**
     * 🎲 Динамическая балансировка частот перед тасованием
     * - Увеличивает вес карт, которые давно не выдавались
     * - Уменьшает вес карт, которые выдавались недавно
     */
    rebalanceFrequencies() {
        // ✅ Считаем, сколько раз каждая карта была в истории
        const cardUsage = new Map();

        for (const cardKey of this.dealtHistory) {
            cardUsage.set(cardKey, (cardUsage.get(cardKey) || 0) + 1);
        }

        // ✅ Корректируем частоты
        for (let i = 0; i < this.cards.length; i++) {
            const card = this.cards[i];
            const cardKey = this.getCardKey(card);
            const usage = cardUsage.get(cardKey) || 0;

            if (usage === 0) {
                // Карта давно не выдавалась — повышаем шанс
                this.frequencies[i] = this.baseFrequency * this.boostFactor;
            } else if (usage >= 3) {
                // Карта выдавалась слишком часто — понижаем шанс
                this.frequencies[i] = this.baseFrequency * this.penaltyFactor;
            } else {
                // Нормальная частота
                this.frequencies[i] = this.baseFrequency;
            }

            // ✅ Гарантируем минимальный вес > 0
            this.frequencies[i] = Math.max(0.1, this.frequencies[i]);
        }

        console.log(`📊 Балансировка частот: ${cardUsage.size} уникальных карт в истории`);
    }

    /**
     * 🔑 Генерирует уникальный ключ для карты
     */
    getCardKey(card) {
        return `${card.suit}-${card.rank}-${card.isSixSpades ? 'joker' : 'normal'}`;
    }

    /**
     * 🃏 Добавляет карту в историю выданных
     */
    recordCardDealt(card) {
        const cardKey = this.getCardKey(card);
        this.dealtHistory.unshift(cardKey); // Добавляем в начало

        // ✅ Ограничиваем размер истории
        if (this.dealtHistory.length > this.maxHistory) {
            this.dealtHistory.pop();
        }
    }

    /**
     * 🔀 Взвешенное тасование с балансировкой
     */
    shuffle() {
        if (!Array.isArray(this.cards) || this.cards.length === 0) {
            console.error('❌ Invalid cards array');
            return;
        }

        // ✅ Сначала балансируем частоты
        this.rebalanceFrequencies();

        console.log('🔀 Тасуем карты с балансировкой...');

        // ✅ Алгоритм Fisher-Yates с весами
        for (let i = this.cards.length - 1; i > 0; i--) {
            // ✅ Считаем суммарный вес оставшихся карт
            let totalWeight = 0;
            for (let j = 0; j <= i; j++) {
                totalWeight += this.frequencies[j];
            }

            // ✅ Выбираем случайный индекс с учётом весов
            let randomValue = Math.random() * totalWeight;
            let cumulativeWeight = 0;

            for (let j = 0; j <= i; j++) {
                cumulativeWeight += this.frequencies[j];
                if (randomValue < cumulativeWeight) {
                    // ✅ Меняем местами карты И их частоты
                    [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
                    [this.frequencies[i], this.frequencies[j]] = [this.frequencies[j], this.frequencies[i]];
                    break;
                }
            }
        }

        console.log('✅ Карты растасованы');
    }

    /**
     * 🎴 Выдаёт карты игроку с записью в историю
     */
    deal(numCards) {
        const dealt = this.cards.splice(0, numCards);
        const dealtFreqs = this.frequencies.splice(0, numCards);

        // ✅ Записываем выданные карты в историю
        for (const card of dealt) {
            this.recordCardDealt(card);
        }

        // ✅ Сбрасываем частоты выданных карт к базовым (они вернутся в колоду позже)
        for (let i = 0; i < dealtFreqs.length; i++) {
            dealtFreqs[i] = this.baseFrequency;
        }

        return dealt;
    }

    /**
     * ♻️ Возвращает карты в колоду (для следующего раунда)
     */
    returnCards(cards) {
        for (const card of cards) {
            this.cards.push(card);
            this.frequencies.push(this.baseFrequency);
        }
    }

    size() {
        return this.cards.length;
    }

    /**
     * 📊 Статистика для отладки
     */
    getStats() {
        const avgFreq = this.frequencies.reduce((a, b) => a + b, 0) / this.frequencies.length;
        const minFreq = Math.min(...this.frequencies);
        const maxFreq = Math.max(...this.frequencies);

        return {
            totalCards: this.cards.length,
            avgFrequency: avgFreq.toFixed(2),
            minFrequency: minFreq.toFixed(2),
            maxFrequency: maxFreq.toFixed(2),
            historySize: this.dealtHistory.length
        };
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
        this.pendingJoker = null;  // { playerIdx, cardIdx, trickCards }
        this.testMode = false;
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
        return CAMPAIGN_MODES[this.currentModeIdx];
    }

    getMaxRounds() {
        const mode = this.getCurrentMode();

        // ✅ КЛАССИКА — всегда 11 раундов
        if (mode === GameMode.CLASSIC) {
            return 11;
        }

        // ✅ ОСТАЛЬНЫЕ РЕЖИМЫ — количество раундов = количеству игроков
        const playerCount = this.players.length;

        // ✅ Минимум 2 игрока, максимум 4
        if (playerCount < 2) return 2;
        if (playerCount > 4) return 4;

        return playerCount;
    }

    getCardsPerRound(roundNumber) {
        const mode = this.getCurrentMode();
        const playerCount = this.players.length;

        // ✅ КЛАССИКА — паттерн 1→2→3→4→5→6→5→4→3→2→1
        if (mode === GameMode.CLASSIC) {
            if (roundNumber < 6) {
                return roundNumber + 1;  // 1, 2, 3, 4, 5, 6
            } else {
                return 11 - roundNumber;  // 5, 4, 3, 2, 1
            }
        }

        // ✅ ОСТАЛЬНЫЕ РЕЖИМЫ — 36 карт / количество игроков
        // Пример: 2 игрока = 18 карт на раунд, 2 раунда
        //         3 игрока = 12 карт на раунд, 3 раунда
        //         4 игрока = 9 карт на раунд, 4 раунда
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

        this.deck = new Deck();

        this.cardsPerRound = this.getCardsPerRound(this.modeRoundCount);

        const totalCardsNeeded = this.cardsPerRound * this.players.length;
        if (totalCardsNeeded > TOTAL_CARDS) {
            console.error(`❌ Не хватает карт! Нужно ${totalCardsNeeded}, есть ${TOTAL_CARDS}`);
            this.cardsPerRound = Math.floor(TOTAL_CARDS / this.players.length);
        }

        this.players.forEach(p => {
            p.hand = this.deck.deal(this.cardsPerRound);
            p.bid = -1;
            p.tricks = 0;
            p.hasBid = false;
            console.log(`🃏 ${p.name} получил ${p.hand.length} карт`);
        });

        // ✅ ГАРАНТИРУЕМ ДЖОКЕР В ТЕСТ-РЕЖИМЕ
        this.ensureJokerInDeal();

        // ✅ ИСПРАВЛЕННОЕ ОПРЕДЕЛЕНИЕ КОЗЫРЯ — ПРОВЕРКА ПО ИМЕНИ РЕЖИМА
        const modeName = mode.name;
        console.log(`МОД ${modeName}`);
        if (modeName !== '🃏 Бескозырка') {
            // ✅ Выбираем случайную карту из колоды как козырь
            const trumpIndex = Math.floor(Math.random() * this.deck.cards.length);
            this.trumpCard = this.deck.cards[trumpIndex];

            if (this.trumpCard.suit === '♠') {
                // ✅ Если пика — козыря нет (особое правило)
                this.trumpSuit = null;
                this.trumpCard = null;
                console.log(`🚫 Козырь: нет (выпала пика)`);
            } else {
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

        if (mode.hasBidding) {
            this.gameState = 'bidding';
            console.log(`🎴 Раунд ${this.modeRoundCount + 1}/${this.actualRounds}: ${this.cardsPerRound} карт, козырь: ${this.trumpSuit || 'нет'} (ТОРГОВЛЯ)`);
        } else {
            this.autoAssignBids();
            this.gameState = 'playing';
            console.log(`🎴 Раунд ${this.modeRoundCount + 1}/${this.actualRounds}: ${this.cardsPerRound} карт, козырь: ${this.trumpSuit || 'нет'} (БЕЗ ТОРГОВЛИ)`);
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
        if (!player || cardIdx < 0 || cardIdx >= player.hand.length) {
            return { success: false, error: 'Неверная карта' };
        }

        const validIndices = this.getValidCards(player);
        if (!validIndices.includes(cardIdx)) {
            return { success: false, error: 'Недопустимый ход! Следуйте масти или бейте козырем.' };
        }

        const card = player.hand.splice(cardIdx, 1)[0];

        // ✅ НЕ устанавливаем leadSuit для джокера — игрок выберет масть позже!
        if (this.cardsPlayedThisTrick.length === 0 && !card.isSixSpades) {
            this.leadSuit = card.suit;
            console.log(`🎴 Первая карта взятки: ${card.rank}${card.suit}, масть хода: ${this.leadSuit}`);
        } else if (this.cardsPlayedThisTrick.length === 0 && card.isSixSpades) {
            console.log(`🃏 Джокер первым ходом — масть будет выбрана игроком`);
        }

        this.cardsPlayedThisTrick.push({ playerIdx, card });
        console.log(`🃏 Игрок ${playerIdx} сыграл ${card.rank}${card.suit}, карт на столе: ${this.cardsPlayedThisTrick.length}`);

        // ✅ ЕСЛИ СЫГРАН ДЖОКЕР — ЗАПРОСИТЬ ВЫБОР СИЛЫ (И ВОЗМОЖНО МАСТИ)
        if (card.isSixSpades) {
            console.log(`🃏 Джокер сыгран игроком ${playerIdx} — ожидание выбора`);

            // ✅ Определяем тип выбора
            const isFirstCard = this.cardsPlayedThisTrick.length === 1;  // ✅ ПРОВЕРЯЕМ ПОСЛЕ push

            // ✅ Сохраняем состояние для ожидания выбора
            this.pendingJoker = {
                playerIdx: playerIdx,
                card: card,
                isFirstCard: isFirstCard  // ✅ Важно для выбора масти
            };

            // ✅ Отправляем событие для выбора
            io.to(this.roomId).emit('jokerPlayed', {
                playerIdx: playerIdx,
                playerName: player.name,
                card: card.toJSON(),
                trickNumber: this.currentTrick + 1,
                isFirstCard: isFirstCard  // ✅ Клиент покажет выбор масти если true
            });

            // ✅ ОТПРАВЛЯЕМ СОСТОЯНИЕ С РУКАМИ ВСЕМ ИГРОКАМ
            this.players.forEach((player, idx) => {
                const socket = this.players[idx].socketId;
                if (socket) {
                    const stateWithHand = this.getGameStateWithHand(idx);
                    io.to(socket).emit('gameState', stateWithHand);
                    console.log(`📤 Отправлено gameState игроку ${idx} с ${stateWithHand.hand.length} карт`);
                }
            });

            // ✅ Возвращаем состояние но НЕ завершаем взятку — ждём выбор
            return {
                success: true,
                gameState: this.getGameState(),
                waitingForJokerChoice: true
            };
        }

        // ✅ ЕСЛИ ВСЕ ПОХОДИЛИ — ОПРЕДЕЛЯЕМ ПОБЕДИТЕЛЯ
        if (this.cardsPlayedThisTrick.length >= this.players.length) {
            return this.completeTrick();
        }

        return { success: true, gameState: this.getGameState() };
    }

    // ✅ ЗАВЕРШЕНИЕ ВЗЯТКИ — ОПРЕДЕЛЕНИЕ ПОБЕДИТЕЛЯ
    completeTrick() {
        const winner = this.determineTrickWinner();
        const winningCard = this.cardsPlayedThisTrick[winner].card;

        this.players[winner].tricks++;
        this.trickLeaderIdx = winner;
        this.currentTrick++;

        console.log(`🏆 Взятку выиграл игрок ${winner} (${this.players[winner].name}) с картой ${winningCard.rank}${winningCard.suit}`);
        console.log(`📊 Всего взяток: ${this.currentTrick}/${this.cardsPerRound}`);

        // ✅ ОТПРАВЛЯЕМ СОСТОЯНИЕ С КАРТАМИ НА СТОЛЕ
        const gameState = this.getGameState();
        io.to(this.roomId).emit('cardPlayed', gameState);

        // ✅ ПРОВЕРЯЕМ ЗАВЕРШЕНИЕ РАУНДА
        if (this.currentTrick >= this.cardsPerRound) {
            console.log('🎯 Раунд завершен');

            io.to(this.roomId).emit('roundFinished', {
                roundNumber: this.modeRoundCount + 1,
                totalRounds: this.actualRounds,
                playersScores: this.players.map(p => ({
                    name: p.name,
                    tricks: p.tricks,
                    bid: p.bid
                }))
            });

            setTimeout(() => {
                return this.endRound();
            }, 5000);

            return { success: true, gameState: gameState, roundEnded: true };
        }

        // ✅ ПАУЗА 3 СЕКУНДЫ ПЕРЕД СБРОСОМ КАРТ
        setTimeout(() => {
            this.cardsPlayedThisTrick = [];
            this.leadSuit = null;
            console.log('🎴 Взятка завершена, сброс leadSuit');

            // ✅ ОТПРАВЛЯЕМ СОСТОЯНИЕ КАЖДОМУ ИГРОКУ С ЕГО РУКОЙ
            this.players.forEach((player, idx) => {
                const socket = this.players[idx].socketId;
                if (socket) {
                    const stateWithHand = this.getGameStateWithHand(idx);
                    io.to(socket).emit('gameState', stateWithHand);
                    console.log(`📤 Отправлено gameState игроку ${idx} с ${stateWithHand.hand.length} карт`);
                }
            });

            console.log('📊 Состояние с руками отправлено всем игрокам');
        }, 3000);

        return { success: true, gameState: gameState, trickEnded: true };
    }

    getValidCards(player) {
        const hand = player.hand;
        const mode = this.getCurrentMode();

        console.log('🔍 getValidCards вызван:');
        console.log('  - Карт в руке:', hand.length);
        console.log('  - Карт на столе:', this.cardsPlayedThisTrick.length);
        console.log('  - Масть хода:', this.leadSuit);
        console.log('  - Козырь:', this.trumpSuit);
        console.log('  - Режим:', mode.name);

        if (this.cardsPlayedThisTrick.length === 0) {
            console.log('  ✅ Первый ход — все карты валидны');
            return hand.map((_, i) => i);
        }

        const leadSuit = this.leadSuit;

        const sameSuitIndices = hand.map((_, i) => i).filter(i => {
            const card = hand[i];
            return card.suit === leadSuit && !card.isSixSpades;
        });

        console.log('  - Карт масти хода:', sameSuitIndices.length);

        if (sameSuitIndices.length > 0) {
            const jokerIndices = hand.map((_, i) => i).filter(i => hand[i].isSixSpades);
            if (jokerIndices.length > 0) {
                console.log('  ✅ Есть масть хода + джокер — джокер можно сыграть с выбором силы');
            }
            return [...sameSuitIndices, ...jokerIndices];
        }

        if (mode === GameMode.NO_TRUMP) {
            console.log('  ✅ Бескозырка — все карты валидны');
            return hand.map((_, i) => i);
        }

        if (this.trumpSuit) {
            const trumpIndices = hand.map((_, i) => i).filter(i => {
                const card = hand[i];
                return card.suit === this.trumpSuit && !card.isSixSpades;
            });

            console.log('  - Карт козырной масти:', trumpIndices.length);

            if (trumpIndices.length > 0) {
                const jokerIndices = hand.map((_, i) => i).filter(i => hand[i].isSixSpades);
                console.log('  ✅ Нет масти хода, есть козыри — возвращаем козыри + джокер');
                return [...trumpIndices, ...jokerIndices];
            }
        }

        console.log('  ✅ Нет масти и козырей — все карты валидны (сброс)');
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

        // ✅ ИСПОЛЬЗУЕМ this.leadSuit (он обновляется при выборе масти джокером)
        const leadSuit = this.leadSuit;

        let bestIdx = 0;
        let bestCard = leadCard;

        for (let i = 1; i < this.cardsPlayedThisTrick.length; i++) {
            const card = this.cardsPlayedThisTrick[i].card;

            // ✅ ОБРАБОТКА ДЖОКЕРА
            if (card.isSixSpades) {
                const jokerPower = card.jokerPower || 'high';

                if (jokerPower === 'high') {
                    // ✅ Джокер-старший бьёт всё
                    bestIdx = i;
                    bestCard = card;
                }
                // ✅ Джокер-младший — игнорируем (он слабее любой обычной карты)
                continue;
            }

            // ✅ Если лучшая карта — джокер-старший, его не перебить
            if (bestCard.isSixSpades && bestCard.jokerPower === 'high') {
                continue;
            }

            // ✅ Если лучшая карта — джокер-младший, обычная карта масти/козыря бьёт его
            if (bestCard.isSixSpades && bestCard.jokerPower === 'low') {
                // ✅ Любая карта масти хода или козыря бьёт джокера-младшего
                if (card.suit === leadSuit || (this.trumpSuit && card.suit === this.trumpSuit)) {
                    bestIdx = i;
                    bestCard = card;
                    continue;
                }
            }

            // ✅ Обычная логика сравнения (если bestCard не джокер)
            if (!bestCard.isSixSpades) {
                // Если масть хода — пики, сравниваем только пики
                if (leadSuit === '♠') {
                    if (card.suit === '♠' && card.value > bestCard.value) {
                        bestIdx = i;
                        bestCard = card;
                    }
                    continue;
                }

                // ✅ Карта масти хода бьёт карту масти хода по значению
                if (card.suit === leadSuit && card.value > bestCard.value) {
                    bestIdx = i;
                    bestCard = card;
                }
                // ✅ Козырь бьёт не-козырь
                else if (this.trumpSuit && card.suit === this.trumpSuit) {
                    if (bestCard.suit !== this.trumpSuit) {
                        bestIdx = i;
                        bestCard = card;
                    } else if (card.value > bestCard.value) {
                        bestIdx = i;
                        bestCard = card;
                    }
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
            if (this.currentModeIdx < CAMPAIGN_MODES.length - 1) {
                this.currentModeIdx++;
                this.modeRoundCount = 0;
                this.actualRounds = this.getMaxRounds();

                if (this.deck) {
                    this.deck.dealtHistory = [];
                    console.log('🔄 Баланс колоды сброшен для нового режима');
                }

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
            totalModes: CAMPAIGN_MODES.length,
            cardsOnTable: this.cardsPlayedThisTrick.map(({ playerIdx, card }) => ({
                playerIdx,
                card: card.toJSON()
            })),
            leadSuit: this.leadSuit,  // ✅ Будет null пока игрок не выберет
            currentTrick: this.currentTrick,
            testMode: this.testMode
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
            socket.join(roomId);
            socket.emit('roomCreated', {
                roomId,
                playerIdx: result.playerIdx,
                testMode: testMode  // ✅ Сообщаем клиенту
            });
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
            socket.emit('roomJoined', { roomId, playerIdx: result.playerIdx });
            io.to(roomId).emit('playerJoined', room.getGameState());
            console.log(`👥 Игрок ${playerName} присоединился к ${roomId}`);
        } else {
            socket.emit('error', result.error);
        }
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

    // ✅ ОБРАБОТЧИК: Игрок выбрал силу джокера (и возможно масть)
    socket.on('jokerChoice', ({ roomId, playerIdx, choice, suit }) => {
        const room = rooms[roomId];
        if (!room || !room.pendingJoker) return;

        console.log(`🃏 Игрок ${playerIdx} выбрал силу джокера: ${choice}${suit ? `, масть: ${suit}` : ''}`);

        // ✅ Применяем выбор к карте
        room.pendingJoker.card.jokerPower = choice;

        // ✅ Если это первый ход — устанавливаем масть
        if (room.pendingJoker.isFirstCard && suit) {
            room.leadSuit = suit;
            console.log(`🎴 Масть хода установлена: ${suit} (джокер-лидер)`);
        } else if (room.pendingJoker.isFirstCard && !suit) {
            // ✅ Если масть не выбрана (баг) — используем дефолт
            room.leadSuit = '♠';
            console.log(`⚠️ Масть не выбрана, установлена по умолчанию: ♠`);
        }

        // ✅ Сохраняем выбор
        room.jokerChoices[playerIdx] = choice;

        // ✅ Очищаем ожидание
        room.pendingJoker = null;

        // ✅ Проверяем, все ли походили
        if (room.cardsPlayedThisTrick.length >= room.players.length) {
            // ✅ Все походили — завершаем взятку
            const result = room.completeTrick();

            if (result && result.success) {
                io.to(roomId).emit('cardPlayed', result.gameState);
                console.log(`✅ Взятка завершена с учётом джокера`);
            }
        } else {
            // ✅ Ещё не все походили — отправляем состояние С РУКАМИ
            console.log(`⏳ Ожидание ходов остальных игроков (${room.cardsPlayedThisTrick.length}/${room.players.length})`);

            room.players.forEach((player, idx) => {
                const socket = room.players[idx].socketId;
                if (socket) {
                    const stateWithHand = room.getGameStateWithHand(idx);
                    io.to(socket).emit('gameState', stateWithHand);
                    console.log(`📤 Отправлено gameState игроку ${idx} с ${stateWithHand.hand.length} карт`);
                }
            });

            console.log('📊 Состояние с руками отправлено всем игрокам');
        }
    });

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

