class OnlinePokerGame {
    constructor() {
        this.socket = io();
        this.roomId = null;
        this.playerIdx = null;
        this.gameState = null;
        this.myHand = [];
        this.isProcessing = false;

        this.setupSocketListeners();
    }

    setupSocketListeners() {
        this.socket.on('connect', () => {
            console.log('✅ Подключено к серверу');
            this.updateStatus('✅ Подключено', 'success');
        });

        this.socket.on('disconnect', () => {
            console.log('❌ Отключено от сервера');
            this.updateStatus('❌ Отключено', 'error');
        });

        this.socket.on('roomCreated', ({ roomId, playerIdx }) => {
            console.log('🏠 Комната создана:', roomId);
            this.roomId = roomId;
            this.playerIdx = playerIdx;
            document.getElementById('displayRoomId').textContent = roomId;
            this.showScreen('waitingScreen');
            this.updatePlayersList();
        });

        this.socket.on('roomJoined', ({ roomId, playerIdx }) => {
            console.log('🚪 В комнате:', roomId);
            this.roomId = roomId;
            this.playerIdx = playerIdx;
            document.getElementById('displayRoomId').textContent = roomId;
            this.showScreen('waitingScreen');
            this.updatePlayersList();
        });

        this.socket.on('playerJoined', (state) => {
            console.log('👥 Игрок присоединился');
            this.gameState = state;
            this.updatePlayersList();
        });

        this.socket.on('playerLeft', (state) => {
            console.log('👤 Игрок вышел');
            this.gameState = state;
            this.updatePlayersList();
        });

        this.socket.on('gameStarted', (state) => {
            console.log('🎮 Игра началась!');
            this.gameState = state;
            this.showScreen('gameScreen');
            this.requestGameState();
        });

        this.socket.on('bidMade', (state) => {
            console.log('📢 Заявка сделана');
            this.gameState = state;
            this.requestGameState();
        });

        this.socket.on('cardPlayed', (state) => {
            console.log('🃏 Карта сыграна');
            this.gameState = state;
            this.requestGameState();
        });

        this.socket.on('gameState', (state) => {
            console.log('📊 Получено состояние игры');
            this.gameState = state;
            this.myHand = state.hand || [];
            this.isProcessing = false;
            this.updateGameDisplay();
        });

        this.socket.on('gameFinished', (state) => {
            console.log('🏆 Игра завершена!');
            this.gameState = state;
            this.showResults();
        });

        this.socket.on('error', (error) => {
            console.error('⚠️ Ошибка:', error);
            if (error.includes('Недопустимый ход')) {
                alert('⚠️ ' + error + '\n\n📜 ПРАВИЛА:\n1️⃣ Есть масть хода — ходи ею\n2️⃣ Нет масти — бей козырем\n3️⃣ Нет ничего — сбрасывай любую');
            } else {
                alert('⚠️ ' + error);
            }
            this.updateStatus(error, 'error');
        });
    }

    createRoom() {
        const playerName = document.getElementById('playerName').value.trim();
        if (!playerName) { alert('Введите ваше имя!'); return; }
        this.socket.emit('createRoom', { playerName, maxPlayers: 4 });
    }

    joinRoom() {
        const playerName = document.getElementById('playerName').value.trim();
        const roomId = document.getElementById('roomIdInput').value.trim().toUpperCase();
        if (!playerName) { alert('Введите ваше имя!'); return; }
        if (!roomId) { alert('Введите код комнаты!'); return; }
        this.socket.emit('joinRoom', { roomId, playerName });
    }

    startGame() {
        console.log('🚀 Начало игры');
        this.socket.emit('startGame', { roomId: this.roomId });
    }

    makeBid(bid) {
        if (this.isProcessing) return;
        this.isProcessing = true;
        console.log('📢 Заявка:', bid);
        this.socket.emit('makeBid', { roomId: this.roomId, playerIdx: this.playerIdx, bid: bid });
    }

    playCard(cardIdx) {
        if (this.isProcessing) {
            console.log('⚠️ Уже обрабатывается запрос');
            return;
        }
        console.log('🃏 playCard вызван:', { cardIdx, playerIdx: this.playerIdx });
        this.isProcessing = true;
        this.socket.emit('playCard', { roomId: this.roomId, playerIdx: this.playerIdx, cardIdx: cardIdx });
    }

    requestGameState() {
        this.socket.emit('getGameState', { roomId: this.roomId, playerIdx: this.playerIdx });
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById(screenId).classList.remove('hidden');
    }

    updateStatus(message, type) {
        const status = document.getElementById('connectionStatus');
        status.textContent = message;
        status.className = 'status ' + type;
    }

    updatePlayersList() {
        if (!this.gameState) return;
        const list = document.getElementById('playersList');
        list.innerHTML = '<h3>👥 Игроки:</h3>';
        this.gameState.players.forEach((player, idx) => {
            const div = document.createElement('div');
            div.className = 'player-waiting';
            div.innerHTML = `${idx === this.playerIdx ? '👉 ' : ''}${player.name} ${player.isDealer ? '👑' : ''}`;
            list.appendChild(div);
        });
        const startBtn = document.getElementById('startBtn');
        if (this.playerIdx === 0 && this.gameState.players.length >= 2) {
            startBtn.classList.remove('hidden');
        } else {
            startBtn.classList.add('hidden');
        }
    }

    updateGameDisplay() {
        if (!this.gameState) {
            console.log('⚠️ Нет состояния игры');
            return;
        }
        console.log('🎨 Обновление интерфейса...');
        this.updateHeaders();
        this.updatePlayersArea();
        this.updateCardsOnTable();
        this.updateControlArea();
    }

    updateHeaders() {
        document.getElementById('modeBar').textContent = `🎮 ${this.gameState.mode}`;
        let infoText = `🎲 Раунд ${this.gameState.roundNumber}/11 | Карт: ${this.gameState.cardsPerRound} | `;
        infoText += this.gameState.trumpSuit ? `Козырь: ${this.gameState.trumpSuit}` : '🚫 Без козырей';
        infoText += ` | Взятка: ${(this.gameState.currentTrick || 0) + 1}/${this.gameState.cardsPerRound}`;
        document.getElementById('infoBar').textContent = infoText;
        document.getElementById('progressBar').textContent = `Режим ${this.gameState.modeIdx}/${this.gameState.totalModes} | Колода: 36 карт`;

        if (this.gameState.gameState === 'bidding') {
            const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
            document.getElementById('turnBar').textContent = `📢 Ход: ${currentPlayer.name} (заявка)`;
        } else if (this.gameState.gameState === 'playing') {
            const currentPlayerIdx = this.getCurrentPlayerIdx();
            const currentPlayer = this.gameState.players[currentPlayerIdx];
            document.getElementById('turnBar').textContent = currentPlayer ? `🎴 Ход: ${currentPlayer.name}` : '🎴 Ход: ...';
        } else {
            document.getElementById('turnBar').textContent = '';
        }

        const dealer = this.gameState.players.find(p => p.isDealer);
        document.getElementById('dealerMarker').textContent = `🎴 ДИЛЕР: ${dealer ? dealer.name : ''}`;
    }

    updatePlayersArea() {
        const area = document.getElementById('playersArea');
        area.innerHTML = '';

        this.gameState.players.forEach((player, idx) => {
            const div = document.createElement('div');
            div.className = `player-card player-position-${idx}`;

            if (idx === this.playerIdx) div.classList.add('active');
            if (player.isDealer) div.classList.add('dealer');

            const avatarLetter = player.name.charAt(0).toUpperCase();
            const bidText = player.bid !== null ? player.bid : '-';

            div.innerHTML = `
                <div class="player-avatar">${avatarLetter}</div>
                <div class="player-name" title="${player.name}">${player.name}</div>
                <div class="player-stats">
                    <span class="score">💰${player.score}</span>
                    <span class="tricks">🏆${player.tricks}</span>
                    <span>📢${bidText}</span>
                    <span>🃏${player.handLength}</span>
                </div>
            `;
            area.appendChild(div);
        });
    }

    updateCardsOnTable() {
        const area = document.getElementById('cardsOnTable');
        area.innerHTML = '';
        if (!this.gameState.cardsOnTable) return;

        this.gameState.cardsOnTable.forEach(({ playerIdx, card }) => {
            const div = document.createElement('div');
            div.className = 'card-on-table';
            const cardClass = card.isSixSpades ? 'joker' : card.suit === '♥' || card.suit === '♦' ? 'hearts' : 'spades';
            const cardText = card.isSixSpades ? '6♠🃏' : `${card.rank}${card.suit}`;
            div.innerHTML = `<div class="card-value ${cardClass}">${cardText}</div>
                <div class="player-name">${this.gameState.players[playerIdx].name}</div>`;
            area.appendChild(div);
        });
    }

    getCurrentPlayerIdx() {
        if (!this.gameState) return null;

        if (this.gameState.gameState === 'bidding') {
            return this.gameState.currentPlayer !== undefined ? this.gameState.currentPlayer : null;
        }

        if (this.gameState.gameState === 'playing') {
            const cardsPlayed = this.gameState.cardsOnTable ? this.gameState.cardsOnTable.length : 0;
            return (this.gameState.trickLeader + cardsPlayed) % this.gameState.players.length;
        }

        return null;
    }

    getValidClientIndices() {
        if (!this.myHand || this.myHand.length === 0) return [];

        const cardsOnTableCount = this.gameState.cardsOnTable ? this.gameState.cardsOnTable.length : 0;
        if (cardsOnTableCount === 0 || !this.gameState.leadSuit) {
            return this.myHand.map((_, i) => i);
        }

        const leadSuit = this.gameState.leadSuit;
        const mode = this.gameState.mode;

        const sameSuitIndices = this.myHand.map((_, i) => i).filter(i =>
            this.myHand[i].suit === leadSuit && !this.myHand[i].isSixSpades
        );

        if (sameSuitIndices.length > 0) {
            const jokerIndices = this.myHand.map((_, i) => i).filter(i => this.myHand[i].isSixSpades);
            return [...sameSuitIndices, ...jokerIndices];
        }

        if (mode === '🃏 Бескозырка') {
            return this.myHand.map((_, i) => i);
        }

        if (this.gameState.trumpSuit) {
            const trumpIndices = this.myHand.map((_, i) => i).filter(i =>
                this.myHand[i].suit === this.gameState.trumpSuit && !this.myHand[i].isSixSpades
            );
            if (trumpIndices.length > 0) {
                const jokerIndices = this.myHand.map((_, i) => i).filter(i => this.myHand[i].isSixSpades);
                return [...trumpIndices, ...jokerIndices];
            }
        }

        return this.myHand.map((_, i) => i);
    }

    renderHandCards(area) {
        if (!this.myHand || this.myHand.length === 0) return;

        const handLabel = document.createElement('div');
        handLabel.className = 'your-hand-label';
        handLabel.textContent = '🃏 Ваши карты:';
        area.appendChild(handLabel);

        const handDiv = document.createElement('div');
        handDiv.className = 'hand-cards';

        const isBlind = this.gameState.mode.includes('Слепая');
        const isBidding = this.gameState.gameState === 'bidding';
        const currentPlayerIdx = this.getCurrentPlayerIdx();
        const isMyTurn = this.gameState.gameState === 'playing' && currentPlayerIdx === this.playerIdx;

        const cardsClickable = !isBlind && !isBidding && isMyTurn;

        this.myHand.forEach((card, idx) => {
            const cardDiv = document.createElement('div');
            const cardClass = card.isSixSpades ? 'joker' :
                card.suit === '♥' || card.suit === '♦' ? 'hearts' : 'spades';

            cardDiv.className = `card ${cardClass}`;
            cardDiv.textContent = card.isSixSpades ? '6♠🃏' : `${card.rank}${card.suit}`;

            if (!cardsClickable) {
                cardDiv.classList.add('disabled');
                if (isBlind) {
                    cardDiv.title = 'Карты скрыты в режиме Слепая';
                } else if (isBidding) {
                    cardDiv.title = 'Сначала сделайте заявку';
                } else if (!isMyTurn) {
                    cardDiv.title = 'Ждите своего хода';
                } else {
                    cardDiv.title = 'Нельзя ходить этой картой';
                }
                cardDiv.style.cursor = 'not-allowed';
            } else {
                const validIndices = this.getValidClientIndices();
                if (!validIndices.includes(idx)) {
                    cardDiv.classList.add('disabled');
                    cardDiv.title = 'Нельзя ходить этой картой по правилам';
                } else {
                    cardDiv.onclick = () => this.playCard(idx);
                    cardDiv.style.cursor = 'pointer';
                }
            }

            handDiv.appendChild(cardDiv);
        });
        area.appendChild(handDiv);
    }

    updateControlArea() {
        const area = document.getElementById('controlArea');
        area.innerHTML = '';

        if (this.gameState.gameState === 'finished') {
            this.showResults();
            return;
        }

        const isBlind = this.gameState.mode.includes('Слепая');
        if (!isBlind && this.myHand && this.myHand.length > 0) {
            this.renderHandCards(area);
        } else if (isBlind) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'message warning';
            msgDiv.innerHTML = `👁️ СЛЕПАЯ — карты скрыты!<br>У вас карт: ${this.myHand?.length || 0}`;
            area.appendChild(msgDiv);
        }

        if (this.gameState.gameState === 'bidding' && this.gameState.currentPlayer === this.playerIdx) {
            this.showBiddingInterface(area);
        } else if (this.gameState.gameState === 'playing') {
            const currentPlayerIdx = this.getCurrentPlayerIdx();
            if (currentPlayerIdx === this.playerIdx) {
                this.showPlayHints(area);
            }
        } else {
            const msg = document.createElement('div');
            msg.className = 'message';
            if (this.gameState.gameState === 'bidding') {
                const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
                msg.textContent = `⏳ ${currentPlayer?.name || '...'} делает заявку...`;
            } else if (this.gameState.gameState === 'playing') {
                const currentPlayerIdx = this.getCurrentPlayerIdx();
                const currentPlayer = this.gameState.players[currentPlayerIdx];
                msg.textContent = `⏳ ${currentPlayer?.name || '...'} ходит...`;
            } else {
                msg.textContent = '⏳ Ожидание...';
            }
            area.appendChild(msg);
        }
    }

    showBiddingInterface(area) {
        const isDealer = this.gameState.players[this.playerIdx].isDealer;
        if (isDealer) {
            const totalBid = this.gameState.players.filter(p => p.bid !== null).reduce((sum, p) => sum + p.bid, 0);
            const forbidden = this.gameState.cardsPerRound - totalBid;
            const warnDiv = document.createElement('div');
            warnDiv.className = 'message warning';
            warnDiv.textContent = `⚠️ Нельзя называть ${forbidden}`;
            area.appendChild(warnDiv);
        }

        const bidDiv = document.createElement('div');
        bidDiv.className = 'bid-options';
        for (let i = 0; i <= this.gameState.cardsPerRound; i++) {
            const btn = document.createElement('div');
            btn.className = 'bid-option';
            btn.textContent = i;
            const isDealer = this.gameState.players[this.playerIdx].isDealer;
            if (isDealer) {
                const totalBid = this.gameState.players.filter(p => p.bid !== null).reduce((sum, p) => sum + p.bid, 0);
                if (i === this.gameState.cardsPerRound - totalBid) {
                    btn.classList.add('disabled');
                } else {
                    btn.onclick = () => this.makeBid(i);
                }
            } else {
                btn.onclick = () => this.makeBid(i);
            }
            bidDiv.appendChild(btn);
        }
        area.appendChild(bidDiv);
    }

    showPlayHints(area) {
        const currentPlayerIdx = this.getCurrentPlayerIdx();
        if (currentPlayerIdx !== this.playerIdx) return;

        let ruleText = '🎴 ПЕРВЫЙ ХОД — ЛЮБАЯ КАРТА!';

        const cardsOnTableCount = this.gameState.cardsOnTable ? this.gameState.cardsOnTable.length : 0;
        if (cardsOnTableCount > 0 && this.gameState.leadSuit) {
            const mode = this.gameState.mode;
            const sameSuitCards = this.myHand.filter(card => card.suit === this.gameState.leadSuit && !card.isSixSpades);

            if (sameSuitCards.length > 0) {
                ruleText = `🎴 ОБЯЗАН ходить в ${this.gameState.leadSuit}! (или 🃏)`;
            } else if (mode !== '🃏 Бескозырка' && this.gameState.trumpSuit) {
                const trumpCards = this.myHand.filter(card => card.suit === this.gameState.trumpSuit && !card.isSixSpades);
                if (trumpCards.length > 0) {
                    ruleText = `🎴 Нет ${this.gameState.leadSuit} — ОБЯЗАН бить ${this.gameState.trumpSuit}! (или 🃏)`;
                } else {
                    ruleText = `🎴 Нет ${this.gameState.leadSuit} и козырей — СБРАСЫВАЙТЕ ЛЮБУЮ!`;
                }
            } else {
                ruleText = `🎴 Нет ${this.gameState.leadSuit} — СБРАСЫВАЙТЕ ЛЮБУЮ!`;
            }
        }

        const ruleDiv = document.createElement('div');
        ruleDiv.className = 'message success';
        ruleDiv.style.marginTop = '15px';
        ruleDiv.textContent = `🔔 ВАШ ХОД! ${ruleText}`;
        area.appendChild(ruleDiv);
    }

    showResults() {
        this.showScreen('resultsScreen');
        const leaderboard = document.getElementById('leaderboard');
        leaderboard.innerHTML = '<h2 style="color: #4ecca3; margin-bottom: 20px;">📊 Итоговые результаты:</h2>';
        const sortedPlayers = [...this.gameState.players].sort((a, b) => b.score - a.score);
        const medals = ['🥇', '🥈', '🥉'];
        sortedPlayers.forEach((player, idx) => {
            const div = document.createElement('div');
            div.className = 'leaderboard-item';
            if (idx === 0) div.classList.add('winner');
            const medal = medals[idx] || '  ';
            div.innerHTML = `<span style="font-size: 1.3em;">${medal}</span> ${idx + 1}. ${player.name} — <strong style="color: #4ecca3;">${player.score}</strong> очков`;
            leaderboard.appendChild(div);
        });
    }
}

const game = new OnlinePokerGame();

