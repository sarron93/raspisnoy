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
                alert('⚠️ ' + error + '\n\n📜 ПРАВИЛА РАСПИСНОГО ПОКЕРА:\n' +
                    '1️⃣ Есть масть хода — ходи ею\n' +
                    '2️⃣ Нет масти — бей козырем\n' +
                    '3️⃣ Нет ничего — сбрасывай любую');
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
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(screenId).classList.add('active');
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
        document.getElementById('modeBar').textContent = `${this.gameState.mode}`;

        const infoBar = document.getElementById('infoBar');
        infoBar.innerHTML = `
            <span>🎲 ${this.gameState.roundNumber}/11</span>
            <span>|</span>
            <span>🃏 ${this.gameState.cardsPerRound}</span>
            <span>|</span>
            <span>${this.gameState.trumpSuit ? `🂡 ${this.gameState.trumpSuit}` : '🚫'}</span>
        `;

        document.getElementById('progressBar').textContent =
            `Режим ${this.gameState.modeIdx}/${this.gameState.totalModes}`;

        if (this.gameState.gameState === 'bidding') {
            const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
            document.getElementById('turnBar').textContent = `📢 ${currentPlayer.name} (заявка)`;
        } else if (this.gameState.gameState === 'playing') {
            const currentPlayerIdx = this.getCurrentPlayerIdx();
            const currentPlayer = this.gameState.players[currentPlayerIdx];
            document.getElementById('turnBar').textContent = currentPlayer ? `🎴 ${currentPlayer.name}` : '🎴 ...';
        } else {
            document.getElementById('turnBar').textContent = '';
        }

        const dealer = this.gameState.players.find(p => p.isDealer);
        document.getElementById('dealerMarker').textContent = `🎴 ${dealer ? dealer.name : ''}`;
    }

    updatePlayersArea() {
        const area = document.getElementById('playersArea');
        area.innerHTML = '';

        this.gameState.players.forEach((player, idx) => {
            const wrapper = document.createElement('div');
            wrapper.className = `player-wrapper player-position-${idx}`;

            if (idx === this.playerIdx) wrapper.classList.add('active');
            if (player.isDealer) wrapper.classList.add('dealer');

            const fullHand = document.createElement('div');
            fullHand.className = 'player-full-hand';

            if (idx === this.playerIdx && this.myHand && this.myHand.length > 0) {
                const isBidding = this.gameState.gameState === 'bidding';
                const currentPlayerIdx = this.getCurrentPlayerIdx();
                const isMyTurn = this.gameState.gameState === 'playing' && currentPlayerIdx === this.playerIdx;
                const cardsClickable = !isBidding && isMyTurn;

                const validIndices = cardsClickable ? this.getValidClientIndices() : [];

                this.myHand.forEach((card, cardIdx) => {
                    const miniCard = this.createPlayerCardMini(
                        card,
                        cardIdx,
                        cardsClickable,
                        validIndices.includes(cardIdx)
                    );
                    fullHand.appendChild(miniCard);
                });
            } else {
                if (player.handLength > 0 && player.handLength <= 6) {
                    for (let i = 0; i < player.handLength; i++) {
                        const miniCard = document.createElement('div');
                        miniCard.className = 'player-card-mini disabled';
                        miniCard.innerHTML = `
                            <span class="player-card-mini-rank">?</span>
                            <span class="player-card-mini-suit">🂠</span>
                        `;
                        miniCard.style.cursor = 'not-allowed';
                        fullHand.appendChild(miniCard);
                    }
                } else if (player.handLength > 6) {
                    const cardCount = document.createElement('div');
                    cardCount.className = 'player-card-count';
                    cardCount.textContent = `🃏${player.handLength}`;
                    fullHand.appendChild(cardCount);
                }
            }

            wrapper.appendChild(fullHand);

            const playerCard = document.createElement('div');
            playerCard.className = 'player-card';

            const avatarLetter = player.name.charAt(0).toUpperCase();
            const bidText = player.bid !== null ? player.bid : '-';

            playerCard.innerHTML = `
                <div class="player-avatar">${avatarLetter}</div>
                <div class="player-name" title="${player.name}">${player.name}</div>
                <div class="player-stats">
                    <span class="score">💰${player.score}</span>
                    <span class="tricks">🏆${player.tricks}</span>
                    <span>📢${bidText}</span>
                    <span>🃏${player.handLength}</span>
                </div>
            `;

            wrapper.appendChild(playerCard);
            area.appendChild(wrapper);
        });
    }

    createPlayerCardMini(card, idx, isClickable = false, isValid = false) {
        const cardDiv = document.createElement('div');
        const cardClass = card.isSixSpades ? 'joker' :
            card.suit === '♥' || card.suit === '♦' ? 'hearts' : 'spades';

        cardDiv.className = `player-card-mini ${cardClass}`;

        const rank = card.isSixSpades ? '🃏' : card.rank;
        const suit = card.isSixSpades ? '🃏' : card.suit;

        cardDiv.innerHTML = `
            <span class="player-card-mini-rank">${rank}</span>
            <span class="player-card-mini-suit">${suit}</span>
        `;

        if (!isClickable || !isValid) {
            cardDiv.classList.add('disabled');
            cardDiv.title = isClickable ? 'Нельзя ходить этой картой' : 'Ждите своего хода';
            cardDiv.style.cursor = 'not-allowed';
        } else {
            cardDiv.onclick = () => this.playCard(idx);
            cardDiv.style.cursor = 'pointer';
            cardDiv.title = 'Нажмите чтобы походить';
        }

        return cardDiv;
    }

    updateCardsOnTable() {
        const area = document.getElementById('cardsOnTable');
        area.innerHTML = '';

        if (!this.gameState.cardsOnTable || this.gameState.cardsOnTable.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.gridColumn = '1 / -1';
            emptyMsg.style.textAlign = 'center';
            emptyMsg.style.color = 'rgba(255, 215, 0, 0.5)';
            emptyMsg.style.fontSize = '0.9em';
            emptyMsg.style.padding = '20px';
            emptyMsg.textContent = '🃏 Карты будут здесь...';
            area.appendChild(emptyMsg);
            return;
        }

        this.gameState.cardsOnTable.forEach(({ playerIdx, card }, index) => {
            const div = this.createCardElement(card, false, true);

            const player = this.gameState.players[playerIdx];
            const isDealer = player.isDealer;
            const isLastCard = index === this.gameState.cardsOnTable.length - 1;
            const playerName = player.name.length > 10 ? player.name.substring(0, 10) + '...' : player.name;

            const badge = document.createElement('div');
            badge.className = `player-badge ${isDealer ? 'dealer' : ''} ${isLastCard ? 'active' : ''}`;
            badge.innerHTML = `${isDealer ? '👑 ' : ''}${playerName}`;
            div.appendChild(badge);

            const order = document.createElement('div');
            order.className = 'play-order';
            order.textContent = index + 1;
            div.appendChild(order);

            div.title = `${player.name} походил ${card.isSixSpades ? '6♠🃏' : `${card.rank}${card.suit}`}\nПорядок: ${index + 1}\n${isDealer ? '👑 Дилер' : ''}`;

            area.appendChild(div);
        });
    }

    createCardElement(card, isMini = false, isOnTable = false) {
        const cardDiv = document.createElement('div');
        const cardClass = card.isSixSpades ? 'joker' :
            card.suit === '♥' || card.suit === '♦' ? 'hearts' : 'spades';

        if (isMini) {
            cardDiv.className = `mini-card ${cardClass}`;
            cardDiv.textContent = card.isSixSpades ? '🃏' : card.suit;
        } else if (isOnTable) {
            cardDiv.className = `card-on-table ${cardClass}`;

            const rank = card.isSixSpades ? '🃏' : card.rank;
            const suit = card.isSixSpades ? '🃏' : card.suit;

            cardDiv.innerHTML = `
                <div class="card-corner card-corner-top">
                    <span class="card-rank">${rank}</span>
                    <span class="card-suit-small">${suit}</span>
                </div>
                <div class="card-center">${suit}</div>
                <div class="card-corner card-corner-bottom">
                    <span class="card-rank">${rank}</span>
                    <span class="card-suit-small">${suit}</span>
                </div>
            `;
        } else {
            cardDiv.className = `card ${cardClass}`;

            const rank = card.isSixSpades ? '🃏' : card.rank;
            const suit = card.isSixSpades ? '🃏' : card.suit;

            cardDiv.innerHTML = `
                <div class="card-corner card-corner-top">
                    <span class="card-rank">${rank}</span>
                    <span class="card-suit-small">${suit}</span>
                </div>
                <div class="card-center">${suit}</div>
                <div class="card-corner card-corner-bottom">
                    <span class="card-rank">${rank}</span>
                    <span class="card-suit-small">${suit}</span>
                </div>
            `;
        }

        return cardDiv;
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

    updateControlArea() {
        const area = document.getElementById('controlArea');
        area.innerHTML = '';

        if (this.gameState.gameState === 'finished') {
            this.showResults();
            return;
        }

        const isBlind = this.gameState.mode.includes('Слепая');

        if (isBlind && this.myHand && this.myHand.length > 0) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'message warning';
            msgDiv.innerHTML = `👁️ СЛЕПАЯ — карты скрыты!<br>У вас карт: ${this.myHand.length}`;
            area.appendChild(msgDiv);
        }

        if (this.gameState.gameState === 'bidding' && this.gameState.currentPlayer === this.playerIdx) {
            this.showBiddingInterface(area);
        } else if (this.gameState.gameState === 'playing') {
            const currentPlayerIdx = this.getCurrentPlayerIdx();
            if (currentPlayerIdx === this.playerIdx) {
                this.showPlayHints(area);
            } else {
                const msg = document.createElement('div');
                msg.className = 'message';
                const currentPlayer = this.gameState.players[currentPlayerIdx];
                msg.textContent = `⏳ ${currentPlayer?.name || '...'} ходит...`;
                area.appendChild(msg);
            }
        } else if (this.gameState.gameState === 'bidding') {
            const msg = document.createElement('div');
            msg.className = 'message';
            const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
            msg.textContent = `⏳ ${currentPlayer?.name || '...'} делает заявку...`;
            area.appendChild(msg);
        }
    }

    showBiddingInterface(area) {
        const isDealer = this.gameState.players[this.playerIdx].isDealer;

        const bidContainer = document.createElement('div');
        bidContainer.className = 'bid-container';

        const bidTitle = document.createElement('div');
        bidTitle.className = 'bid-title';
        bidTitle.textContent = '📢 Сделайте заявку на взятки:';
        bidContainer.appendChild(bidTitle);

        if (isDealer) {
            const totalBid = this.gameState.players.filter(p => p.bid !== null).reduce((sum, p) => sum + p.bid, 0);
            const forbidden = this.gameState.cardsPerRound - totalBid;
            const warnDiv = document.createElement('div');
            warnDiv.className = 'message warning';
            warnDiv.style.fontSize = '0.9rem';
            warnDiv.style.padding = '8px 12px';
            warnDiv.style.margin = '0 0 12px 0';
            warnDiv.textContent = `⚠️ Нельзя называть ${forbidden}`;
            bidContainer.appendChild(warnDiv);
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

        bidContainer.appendChild(bidDiv);
        area.appendChild(bidContainer);
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

