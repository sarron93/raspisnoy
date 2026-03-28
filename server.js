const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎰 Расписной Покер Онлайн</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
<div class="container">
    <div id="menuScreen" class="screen">
        <h1 class="title">🎰 РАСПИСНОЙ ПОКЕР ОНЛАЙН 🎰</h1>
        <p class="subtitle">🏆 Кампания • 5 режимов • 36 карт • 6♠ = Джокер</p>

        <div class="menu-panel">
            <div class="input-group">
                <label for="playerName">👤 Ваше имя:</label>
                <input type="text" id="playerName" placeholder="Введите имя" maxlength="20">
            </div>

            <div class="button-group">
                <button class="btn btn-primary" onclick="game.createRoom()">🏠 Создать комнату</button>
                <div class="join-room">
                    <input type="text" id="roomIdInput" placeholder="Код комнаты" maxlength="6">
                    <button class="btn btn-secondary" onclick="game.joinRoom()">🚪 Войти</button>
                </div>
            </div>

            <div id="connectionStatus" class="status"></div>
        </div>
    </div>

    <div id="waitingScreen" class="screen hidden">
        <h2 style="color: #ffd700; margin-bottom: 20px;">🏠 Комната: <span id="displayRoomId" style="color: #4ecca3;"></span></h2>
        <div id="playersList" class="players-list"></div>
        <button id="startBtn" class="btn btn-primary hidden" onclick="game.startGame()">🚀 Начать игру</button>
        <p class="waiting-text">⏳ Ожидание игроков...</p>
    </div>

    <div id="gameScreen" class="screen hidden">
        <div class="game-header">
            <div class="mode-bar" id="modeBar">🎮 Режим</div>
            <div class="info-bar" id="infoBar">Информация</div>
            <div class="turn-bar" id="turnBar"></div>
            <div class="progress-bar" id="progressBar">Прогресс</div>
        </div>

        <div class="table-area">
            <div class="dealer-marker" id="dealerMarker">🎴 ДИЛЕР: </div>
            <div class="players-area" id="playersArea"></div>
            <div class="cards-on-table" id="cardsOnTable"></div>
        </div>

        <div class="control-area" id="controlArea"></div>
    </div>

    <div id="resultsScreen" class="screen hidden">
        <h1 class="title">🏆 КАМПАНИЯ ЗАВЕРШЕНА 🏆</h1>
        <div class="leaderboard" id="leaderboard"></div>
        <button class="btn btn-primary" onclick="location.reload()">🔄 Новая игра</button>
    </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="/game.js"></script>
</body>
</html>


  `);
});

const rooms = {};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALUES = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

const GameMode = {
    CLASSIC: { name: '🎯 Классика', fullDeck: false },
    NO_TRUMP: { name: '🃏 Бескозырка', fullDeck: true },
    GOLDEN: { name: '💰 Золотая', fullDeck: true },
    BLIND: { name: '👁️ Слепая', fullDeck: true },
    KHAPKI: { name: '🔥 Хапки', fullDeck: false }
};

const CAMPAIGN_MODES = [
    GameMode.CLASSIC,
    GameMode.NO_TRUMP,
    GameMode.GOLDEN,
    GameMode.BLIND,
    GameMode.KHAPKI
];

class Card {
    constructor(suit, rank, isSixSpades = false) {
        this.suit = suit;
        this.rank = rank;
        this.isSixSpades = isSixSpades;
        this.value = VALUES[rank] || 100;
    }

    toJSON() {
        return {
            suit: this.suit,
            rank: this.rank,
            isSixSpades: this.isSixSpades,
            value: this.value
        };
    }
}

class Deck {
    constructor() {
        this.cards = [];
        this.createDeck();
    }

    createDeck() {
        for (let suit of SUITS) {
            for (let rank of RANKS) {
                const isSixSpades = (suit === '♠' && rank === '6');
                this.cards.push(new Card(suit, rank, isSixSpades));
            }
        }
        this.shuffle();
    }

    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    deal(numCards) {
        return this.cards.splice(0, numCards);
    }

    size() {
        return this.cards.length;
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
        return 11;
    }

    startGame() {
        if (this.players.length < 2) {
            return { success: false, error: 'Нужно минимум 2 игрока' };
        }

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
        this.players.forEach(p => {
            p.hand = this.deck.deal(this.cardsPerRound);
            p.bid = -1;
            p.tricks = 0;
            p.hasBid = false;
        });

        if (mode !== GameMode.NO_TRUMP && this.deck.size() > 0) {
            this.trumpCard = this.deck.cards[this.deck.size() - 1];
            if (this.trumpCard.suit === '♠') {
                this.trumpSuit = null;
                this.trumpCard = null;
            } else {
                this.trumpSuit = this.trumpCard.suit;
            }
        } else {
            this.trumpSuit = null;
            this.trumpCard = null;
        }

        this.biddingOrder = [];
        for (let i = 0; i < this.players.length; i++) {
            this.biddingOrder.push((this.dealerIdx + 1 + i) % this.players.length);
        }
        this.currentPlayerIdx = 0;
        this.gameState = 'bidding';

        console.log(`🎴 Новый раунд: ${this.cardsPerRound} карт, козырь: ${this.trumpSuit || 'нет'}`);
        return this.getGameState();
    }

    makeBid(playerIdx, bid) {
        const player = this.players[playerIdx];
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

        if (this.cardsPlayedThisTrick.length === 0) {
            this.leadSuit = card.suit;
            console.log(`🎴 Первая карта взятки: ${card.rank}${card.suit}, масть хода: ${this.leadSuit}`);
        }

        this.cardsPlayedThisTrick.push({ playerIdx, card });
        console.log(`🃏 Игрок ${playerIdx} сыграл ${card.rank}${card.suit}, карт на столе: ${this.cardsPlayedThisTrick.length}`);

        if (this.cardsPlayedThisTrick.length >= this.players.length) {
            const winner = this.determineTrickWinner();
            this.players[winner].tricks++;
            this.trickLeaderIdx = winner;
            this.currentTrick++;
            console.log(`🏆 Взятку выиграл игрок ${winner}, всего взяток: ${this.currentTrick}/${this.cardsPerRound}`);

            if (this.currentTrick >= this.cardsPerRound) {
                console.log('🎯 Раунд завершен');
                return this.endRound();
            }

            this.cardsPlayedThisTrick = [];
            this.leadSuit = null;
            console.log('🎴 Взятка завершена, сброс leadSuit');
        }

        return { success: true, gameState: this.getGameState() };
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
            console.log('  ✅ Есть масть хода — возвращаем масть + джокер');
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

    determineTrickWinner() {
        if (this.cardsPlayedThisTrick.length === 0) return this.trickLeaderIdx;

        const leadCard = this.cardsPlayedThisTrick[0].card;
        const leadSuit = leadCard.suit;

        let bestIdx = 0;
        let bestCard = leadCard;

        for (let i = 1; i < this.cardsPlayedThisTrick.length; i++) {
            const card = this.cardsPlayedThisTrick[i].card;

            if (card.isSixSpades) {
                bestIdx = i;
                bestCard = card;
                continue;
            }

            if (bestCard.isSixSpades) continue;

            if (leadSuit === '♠') {
                if (card.suit === '♠' && card.value > bestCard.value) {
                    bestIdx = i;
                    bestCard = card;
                }
                continue;
            }

            if (card.suit === leadSuit && card.value > bestCard.value) {
                bestIdx = i;
                bestCard = card;
            } else if (this.trumpSuit && card.suit === this.trumpSuit) {
                if (bestCard.suit !== this.trumpSuit) {
                    bestIdx = i;
                    bestCard = card;
                } else if (card.value > bestCard.value) {
                    bestIdx = i;
                    bestCard = card;
                }
            }
        }

        return this.cardsPlayedThisTrick[bestIdx].playerIdx;
    }

    endRound() {
        const mode = this.getCurrentMode();
        let multiplier = 1;
        if ([GameMode.GOLDEN, GameMode.BLIND, GameMode.KHAPKI].includes(mode)) {
            multiplier = 2;
        }

        this.players.forEach(p => {
            let points = 0;
            if (mode === GameMode.MISER) {
                points = p.tricks === 0 ? 20 * multiplier : -10 * p.tricks * multiplier;
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
        const maxRounds = this.getMaxRounds();

        if (this.modeRoundCount < maxRounds) {
            if (this.modeRoundCount < 6) {
                this.cardsPerRound = this.modeRoundCount + 1;
            } else {
                this.cardsPerRound = maxRounds - this.modeRoundCount;
            }
            console.log(`🎴 Следующий раунд: ${this.cardsPerRound} карт`);
        }

        if (this.modeRoundCount >= maxRounds) {
            if (this.currentModeIdx < CAMPAIGN_MODES.length - 1) {
                this.currentModeIdx++;
                this.modeRoundCount = 0;
                this.cardsPerRound = 1;
                console.log(`🎉 Смена режима: ${this.getCurrentMode().name}`);
            } else {
                this.gameState = 'finished';
                console.log('🏆 Кампания завершена!');
                return { success: true, gameState: this.getGameState(), finished: true };
            }
        }

        this.dealerIdx = (this.dealerIdx + 1) % this.players.length;
        console.log(`🎴 Новый дилер: игрок ${this.dealerIdx}`);

        this.startRound();

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
                hasBid: p.hasBid,
                handLength: p.hand.length,
                isDealer: idx === this.dealerIdx
            })),
            currentPlayer: this.gameState === 'bidding' ? this.biddingOrder[this.currentPlayerIdx] : null,
            trickLeader: this.trickLeaderIdx,
            cardsPerRound: this.cardsPerRound,
            trumpSuit: this.trumpSuit,
            mode: this.getCurrentMode().name,
            roundNumber: this.modeRoundCount + 1,
            maxRounds: this.getMaxRounds(),
            modeIdx: this.currentModeIdx + 1,
            totalModes: CAMPAIGN_MODES.length,
            cardsOnTable: this.cardsPlayedThisTrick.map(({ playerIdx, card }) => ({
                playerIdx,
                card: card.toJSON()
            })),
            leadSuit: this.leadSuit,
            currentTrick: this.currentTrick
        };
    }

    getGameStateWithHand(playerIdx) {
        const state = this.getGameState();
        state.hand = this.getPlayerHand(playerIdx);
        return state;
    }

    getPlayerHand(playerIdx) {
        const player = this.players[playerIdx];
        if (!player) return [];
        return player.hand.map(card => card.toJSON());
    }
}

io.on('connection', (socket) => {
    console.log('🔌 Игрок подключился:', socket.id);

    socket.on('createRoom', ({ playerName, maxPlayers = 4 }) => {
        const roomId = uuidv4().substr(0, 6).toUpperCase();
        const room = new OnlineGame(roomId, maxPlayers);

        const result = room.addPlayer(socket.id, playerName);
        if (result.success) {
            rooms[roomId] = room;
            socket.join(roomId);
            socket.emit('roomCreated', { roomId, playerIdx: result.playerIdx });
            console.log(`🏠 Комната создана: ${roomId}`);
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

    socket.on('disconnect', () => {
        console.log('🔌 Игрок отключился:', socket.id);

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const shouldDelete = room.removePlayer(socket.id);

            io.to(roomId).emit('playerLeft', room.getGameState());

            if (shouldDelete) {
                delete rooms[roomId];
                console.log(`🗑️ Комната ${roomId} удалена`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎰 Сервер запущен на порту ${PORT}`);
    console.log(`🌐 Откройте http://localhost:${PORT} в браузере`);
});

