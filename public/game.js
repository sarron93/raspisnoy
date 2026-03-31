const SUITS = ['♠', '♥', '♦', '♣'];

const SUITS_VIEW_MAP = {
  '♠': '♠️',
  '♥': '♥️',
  '♦': '♦️',
  '♣': '♣️',
};

class OnlinePokerGame {
    constructor() {
        this.socket = io();
        this.roomId = null;
        this.playerIdx = null;
        this.gameState = null;
        this.myHand = [];
        this.isProcessing = false;

        // ✅ РЕКОННЕКТ ЛОГИКА
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000; // 1 секунда
        this.isReconnecting = false;
        this.wasInGame = false;

        this.setupSocketListeners();
    }

    setupSocketListeners() {
        this.socket.on('connect', () => {
            console.log('✅ Подключено к серверу');
            this.updateStatus('✅ Подключено', 'success');

            // ✅ Если были в игре и переподключились — пробуем восстановить
            if (this.isReconnecting && this.wasInGame && this.roomId && this.playerIdx !== null) {
                console.log('🔄 Восстановление соединения, запрашиваем состояние...');
                this.reconnectAttempts = 0;
                this.isReconnecting = false;
                this.requestGameState();
            }
        });

        this.socket.on('disconnect', (reason) => {
            console.log('❌ Отключено от сервера:', reason);
            this.wasInGame = this.gameState && this.gameState.gameState === 'playing';
            this.updateStatus('❌ Отключено', 'error');

            // ✅ Пытаемся переподключиться если были в игре
            if (this.wasInGame) {
                this.attemptReconnect();
            }
        });

        this.socket.on('connect_error', (error) => {
            console.error('⚠️ Ошибка подключения:', error.message);
            this.updateStatus('⚠️ Ошибка подключения', 'error');
        });

        this.socket.on('reconnect_attempt', (attemptNumber) => {
            console.log(`🔄 Попытка переподключения ${attemptNumber}/${this.maxReconnectAttempts}`);
            this.updateStatus(`🔄 Переподключение... (${attemptNumber}/${this.maxReconnectAttempts})`, 'warning');
        });

        this.socket.on('reconnect_failed', () => {
            console.error('❌ Все попытки переподключения исчерпаны');
            this.updateStatus('❌ Не удалось подключиться', 'error');
            this.isReconnecting = false;

            // ✅ Возвращаем в меню после неудачи
            if (this.wasInGame) {
                setTimeout(() => {
                    alert('❌ Не удалось восстановить соединение\n\nВы вернётесь в главное меню.');
                    this.showScreen('menuScreen');
                    this.wasInGame = false;
                }, 1000);
            }
        });

        this.socket.on('roomCreated', ({ roomId, playerIdx }) => {
            console.log('🏠 Комната создана:', roomId);
            this.roomId = roomId;
            this.playerIdx = playerIdx;
            this.wasInGame = false;
            document.getElementById('displayRoomId').textContent = roomId;
            this.showScreen('waitingScreen');
            this.updatePlayersList();
        });

        this.socket.on('roomJoined', ({ roomId, playerIdx }) => {
            console.log('🚪 В комнате:', roomId);
            this.roomId = roomId;
            this.playerIdx = playerIdx;
            this.wasInGame = false;
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
            this.wasInGame = true;
            this.showScreen('gameScreen');
            this.requestGameState();
        });

        this.socket.on('bidMade', (state) => {
            console.log('📢 Заявка сделана');
            this.gameState = state;

            // ✅ В СЛЕПОЙ — после ставки запрашиваем состояние с рукой
            if (this.gameState.mode === '👁️ Слепая' && this.gameState.players[this.playerIdx]?.hasBid) {
                console.log('👁️ Ставка сделана — запрашиваем карты');
                this.requestGameState();
            } else {
                this.requestGameState();
            }
        });

        this.socket.on('cardPlayed', (state) => {
            console.log('🃏 Карта сыграна');

            // ✅ Обновляем руку если пришла
            if (state.hand !== undefined) {
                this.myHand = this._validateHand(state.hand);
            }

            this.gameState = state;

            // ✅ Сбрасываем isProcessing только если взятка завершена или ход перешёл
            if (state.trickEnded || state.roundEnded) {
                this.isProcessing = false;
                if (this.playCardTimeout) {
                    clearTimeout(this.playCardTimeout);
                    this.playCardTimeout = null;
                }
            }

            this.updateGameDisplay();
        });

        // ✅ ОБРАБОТЧИК: Карты очищены со стола
        this.socket.on('trickCleared', (state) => {
            console.log('🎴 Карты очищены со стола');
            console.log('🃏 Карт в руке:', state.hand?.length || 0);
            console.log('📊 cardsOnTable:', state.cardsOnTable?.length || 0);

            // ✅ Обновляем gameState но НЕ myHand (он придёт с gameState)
            this.gameState = state;

            // ✅ Обновляем интерфейс чтобы показать пустой стол
            this.updateCardsOnTable();
            this.updateHeaders();

            console.log('⏳ Ждём gameState с рукой...');
        });

        this.socket.on('gameState', (state) => {
            console.log('📊 Получено состояние игры');

            this.gameState = state;
            this.myHand = this._validateHand(state.hand);

            // ✅ Сбрасываем isProcessing только если это не ожидание джокера
            if (!state.waitingForJokerChoice) {
                this.isProcessing = false;
                if (this.playCardTimeout) {
                    clearTimeout(this.playCardTimeout);
                    this.playCardTimeout = null;
                }
            }

            this.updateGameDisplay();
        });

        this.socket.on('gameFinished', (state) => {
            console.log('🏆 Игра завершена!');
            this.gameState = state;
            this.wasInGame = false;
            this.showResults();
        });

        this.socket.on('gameAborted', ({ reason, finalState }) => {
            console.log('🏁 Игра прервана:', reason);
            this.wasInGame = false;
            alert(`🏁 ${reason}\n\nРаунд завершён досрочно.`);
            this.showScreen('menuScreen');
            this.updateStatus('🔄 Готов к новой игре', 'success');
        });

        this.socket.on('playerDisconnected', ({ playerName, reason, gameState }) => {
            console.log('⚠️ Игрок отключился:', playerName, reason);
            alert(`⚠️ ${reason}\n\nИгрок "${playerName}" покинул стол.\n\nИгра будет завершена.`);
            this.wasInGame = false;
            this.showScreen('menuScreen');
            this.updateStatus('⚠️ Игра прервана', 'error');
        });

        this.socket.on('roomClosed', ({ reason }) => {
            console.log('🚪 Комната закрыта:', reason);
            this.wasInGame = false;
            alert(`🚪 ${reason}\n\nВы вернётесь в главное меню.`);
            this.showScreen('menuScreen');
            this.roomId = null;
            this.playerIdx = null;
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
            this.isProcessing = false;
        });

        // ✅ ОБРАБОТЧИК: Раунд завершен
        this.socket.on('roundFinished', ({ roundNumber, totalRounds, playersScores }) => {
            console.log('🎯 Раунд завершен:', roundNumber, 'из', totalRounds);

            // ✅ Показываем уведомление о завершении раунда
            this.showRoundFinishedNotification(roundNumber, totalRounds, playersScores);

            // ✅ Блокируем интерфейс на время паузы
            this.isProcessing = true;
        });

        // ✅ ОБРАБОТЧИК: Новый раунд начался
        this.socket.on('roundStarted', (state) => {
            console.log('🎴 Новый раунд начался');
            console.log('🃏 Карт в руке:', state.hand?.length || 0);

            this.gameState = state;
            this.myHand = state.hand || [];  // ✅ ВАЖНО: обновляем руку
            this.isProcessing = false;
            this.updateGameDisplay();
        });

        // ✅ ОБРАБОТЧИК: Джокер сыгран — нужно выбрать силу (и возможно масть)
        this.socket.on('jokerPlayed', ({ playerIdx, playerName, card, trickNumber, isFirstCard }) => {
            console.log('🃏 jokerPlayed:', { playerIdx, playerName, card, trickNumber, isFirstCard });  // ✅ ОТЛАДКА

            if (playerIdx === this.playerIdx) {
                console.log('🎨 Показываем модальное окно, isFirstCard:', isFirstCard);  // ✅ ОТЛАДКА
                this.showJokerChoiceModal(card, trickNumber, isFirstCard);
            } else {
                this.updateStatus(`⏳ ${playerName} выбирает ${isFirstCard ? 'масть и силу' : 'силу'} джокера...`, 'warning');
                // ✅ Блокируем интерфейс пока игрок не выберет
                this.isProcessing = true;
            }
        });
    }

    /**
     * ✅ ПРОВЕРКА И ОЧИСТКА РУКИ ОТ ДУБЛИКАТОВ И ОШИБОК
     */
    _validateHand(hand) {
        // Если рука не массив — возвращаем пустую
        if (!Array.isArray(hand)) {
            console.warn('⚠️ Рука не массив, очищаем');
            return [];
        }

        const seen = new Set();
        const valid = [];

        for (const card of hand) {
            // Пропускаем пустые или невалидные карты
            if (!card || !card.suit || !card.rank) {
                console.warn('⚠️ Невалидная карта удалена:', card);
                continue;
            }

            // Создаём уникальный ключ для проверки дублей
            const key = `${card.suit}${card.rank}${card.isSixSpades ? '_JOKER' : ''}`;

            if (seen.has(key)) {
                console.warn('🚨 Найден дубликат карты:', key);
                continue;
            }

            seen.add(key);
            valid.push(card);
        }

        // Проверка на критическое количество карт (в расписном покере макс. 36, обычно меньше)
        if (valid.length > 18) {
            console.error('🚨 Критическая ошибка: слишком много карт в руке:', valid.length);
            // Возвращаем как есть, но с логом для отладки
        }

        return valid;
    }

    // ✅ МЕТОД: Показ уведомления о завершении раунда
    showRoundFinishedNotification(roundNumber, totalRounds, playersScores) {
        // ✅ Создаём уведомление
        const notification = document.createElement('div');
        notification.className = 'round-finished-notification';
        notification.id = 'roundFinishedNotification';

        // ✅ Формируем таблицу результатов раунда
        let scoresHTML = '';
        playersScores.forEach(player => {
            const success = player.tricks === player.bid;
            scoresHTML += `
            <div class="player-score ${success ? 'success' : 'fail'}">
                <span class="player-name">${player.name}</span>
                <span class="player-result">
                    ${player.tricks}/${player.bid}
                    ${success ? '✅' : '❌'}
                </span>
            </div>
        `;
        });

        notification.innerHTML = `
        <div class="trophy">🎯</div>
        <div class="round-title">Раунд завершен</div>
        <div class="round-number">${roundNumber} из ${totalRounds}</div>
        <div class="scores-container">
            ${scoresHTML}
        </div>
        <div class="countdown">
            Следующий раунд через <span id="countdownTimer">5</span> сек...
        </div>
    `;

        document.body.appendChild(notification);

        // ✅ Запускаем обратный отсчёт
        let secondsLeft = 5;
        const countdownInterval = setInterval(() => {
            secondsLeft--;
            const timerElement = document.getElementById('countdownTimer');
            if (timerElement) {
                timerElement.textContent = secondsLeft;
            }

            if (secondsLeft <= 0) {
                clearInterval(countdownInterval);
            }
        }, 1000);

        // ✅ Удаляем уведомление через 5 секунд
        setTimeout(() => {
            notification.style.animation = 'roundFinishedSlide 0.4s ease reverse forwards';
            setTimeout(() => {
                notification.remove();
            }, 400);
        }, 5000);
    }


    attemptReconnect() {
        if (this.isReconnecting) return;

        this.isReconnecting = true;
        this.reconnectAttempts = 0;

        console.log('🔄 Запуск процесса переподключения...');

        const tryReconnect = () => {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.error('❌ Все попытки переподключения исчерпаны');
                this.isReconnecting = false;
                return;
            }

            this.reconnectAttempts++;
            console.log(`🔄 Попытка ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

            this.updateStatus(`🔄 Переподключение... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'warning');

            // ✅ Пытаемся подключиться
            this.socket.connect();

            // ✅ Если не подключились за 3 секунды — пробуем снова
            setTimeout(() => {
                if (!this.socket.connected && this.isReconnecting) {
                    tryReconnect();
                }
            }, 3000);
        };

        tryReconnect();
    }

    // ✅ МЕТОД: Сброс состояния реконнекта
    resetReconnectState() {
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.wasInGame = false;
    }

    createRoom(testMode = false) {
        const playerName = document.getElementById('playerName').value.trim();
        if (!playerName) { alert('Введите ваше имя!'); return; }

        this.socket.emit('createRoom', {
            playerName,
            maxPlayers: 4,
            testMode: testMode  // ✅ Передаём флаг
        });
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
        // ✅ Двойная проверка
        if (this.isProcessing) {
            console.log('⚠️ Уже обрабатывается запрос, игнорируем');
            return;
        }

        // ✅ Проверка что есть рука
        if (!this.myHand || this.myHand.length === 0) {
            console.warn('⚠️ Нет карт в руке');
            return;
        }

        // ✅ Проверка что карта существует
        if (cardIdx < 0 || cardIdx >= this.myHand.length) {
            console.warn('⚠️ Неверный индекс карты:', cardIdx);
            return;
        }

        console.log('🃏 playCard вызван:', { cardIdx, playerIdx: this.playerIdx });
        this.isProcessing = true;

        // ✅ Таймаут на случай если сервер не ответит
        this.playCardTimeout = setTimeout(() => {
            console.warn('⚠️ Таймаут хода, сброс isProcessing');
            this.isProcessing = false;
            this.playCardTimeout = null;
        }, 5000);

        this.socket.emit('playCard', {
            roomId: this.roomId,
            playerIdx: this.playerIdx,
            cardIdx: cardIdx
        });
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
        const modeBar = document.getElementById('modeBar');
        const turnBar = document.getElementById('turnBar');
        const infoBar = document.getElementById('infoBar');

        modeBar.textContent = `${this.gameState.mode}${this.gameState.testMode ? ' 🧪' : ''}`;

        modeBar.textContent = `${this.gameState.mode}`;

        modeBar.className = 'mode-bar';
        turnBar.className = 'turn-bar';

        if (this.gameState.mode === '😈 Мизер') {
            modeBar.classList.add('miser');
            turnBar.classList.add('miser');
        }

        const maxRounds = this.gameState.maxRounds || 11;
        infoBar.innerHTML = `
        <span>🎲 ${this.gameState.roundNumber}/${maxRounds}</span>
        <span>|</span>
        <span>🃏 ${this.gameState.cardsPerRound}</span>
        <span>|</span>
        <span>${SUITS_VIEW_MAP[this.gameState.trumpSuit] || '🚫'}</span>
        ${this.gameState.testMode ? '<span style="color: var(--accent);">🧪 ТЕСТ</span>' : ''}
    `;

        document.getElementById('progressBar').textContent =
            `Режим ${this.gameState.modeIdx}/${this.gameState.totalModes}`;

        if (this.gameState.gameState === 'bidding') {
            const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
            document.getElementById('turnBar').textContent = `📢 ${currentPlayer.name} (заявка)`;
        } else if (this.gameState.gameState === 'playing') {
            const currentPlayerIdx = this.getCurrentPlayerIdx();
            const currentPlayer = this.gameState.players[currentPlayerIdx];
            document.getElementById('turnBar').textContent = currentPlayer ? `🎴 ${currentPlayer.name}` : '🎴 Ход: ...';
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
            const playersAmount = this.gameState.players.length
            const playerPos = (idx - this.playerIdx + playersAmount) % playersAmount
            wrapper.className = `player-wrapper player-position-${playerPos}`;

            if (idx === this.playerIdx) wrapper.classList.add('active');
            if (player.isDealer) wrapper.classList.add('dealer');

            const fullHand = document.createElement('div');
            fullHand.className = 'player-full-hand';

            // ✅ В СЛЕПОЙ — ПРОВЕРЯЕМ СДЕЛАЛ ЛИ ИГРОК СТАВКУ
            const mode = this.gameState.mode;
            const isBlind = mode === '👁️ Слепая';

            // ✅ ДЛЯ ТЕКУЩЕГО ИГРОКА — ИСПОЛЬЗУЕМ this.myHand
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
                        validIndices.includes(cardIdx) || isBidding
                    );
                    fullHand.appendChild(miniCard);
                });
            } else {
                // ✅ ДЛЯ ДРУГИХ ИГРОКОВ — ИСПОЛЬЗУЕМ handLength из gameState
                if (isBlind && !player.hasBid) {
                    // ✅ Скрываем количество карт пока ставка не сделана
                    const cardCount = document.createElement('div');
                    cardCount.className = 'player-card-count';
                    cardCount.textContent = `👁️ ?`;
                    fullHand.appendChild(cardCount);
                } else {
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
            const bidText = player.hasBid ? player.bid : '-';

            playerCard.innerHTML = `
            <div class="player-avatar">${avatarLetter}</div>
            <div class="player-name" title="${player.name}">${player.name}</div>
            <div class="player-stats">
                <span class="score">💰${player.score}</span>
                <span class="tricks">🏆${player.tricks}</span>
                <span>📢${bidText}</span>
                <span>🃏${player.hasBid ? player.handLength : '?'}</span>
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

        if (!isValid) {
            cardDiv.classList.add('disabled');
        }

        // ✅ Блокируем клики если isProcessing
        if (!isClickable || !isValid || this.isProcessing) {
            cardDiv.title = this.isProcessing ? '⏳ Обработка хода...' : (isClickable ? 'Нельзя ходить этой картой' : 'Ждите своего хода');
            cardDiv.style.cursor = 'not-allowed';
            cardDiv.style.opacity = '0.5';  // ✅ Визуальная блокировка
            return cardDiv;
        }

        cardDiv.onclick = () => {
            // ✅ Двойная проверка перед кликом
            if (this.isProcessing) {
                console.log('⚠️ Клик заблокирован (isProcessing)');
                return;
            }
            this.playCard(idx);
        };
        cardDiv.style.cursor = 'pointer';
        cardDiv.title = 'Нажмите чтобы походить';

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

    // ✅ МЕТОД: Создание элемента карты
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
        if (!this.gameState) {
            console.log('❌ gameState is null');
            return null;
        }

        // ✅ ФАЗА ТОРГОВЛИ
        if (this.gameState.gameState === 'bidding') {
            const idx = this.gameState.currentPlayer !== undefined ? this.gameState.currentPlayer : null;
            console.log('📢 bidding currentPlayer:', idx);
            return idx;
        }

        // ✅ ФАЗА РОЗЫГРЫША
        if (this.gameState.gameState === 'playing') {
            const cardsPlayed = this.gameState.cardsOnTable ? this.gameState.cardsOnTable.length : 0;
            const currentPlayerIdx = (this.gameState.trickLeader + cardsPlayed) % this.gameState.players.length;
            console.log('🎴 playing currentPlayerIdx:', {
                trickLeader: this.gameState.trickLeader,
                cardsPlayed: cardsPlayed,
                playersLength: this.gameState.players.length,
                result: currentPlayerIdx
            });
            return currentPlayerIdx;
        }

        return null;
    }

    getValidClientIndices() {
        if (!this.myHand || this.myHand.length === 0) return [];

        // ✅ Если есть условие джокера — находим ОДНУ конкретную карту
        if (this.gameState.jokerCondition &&
            this.gameState.jokerPlayerIdx !== this.playerIdx) {

            const { suit, cardType } = this.gameState.jokerCondition;

            // Находим все карты нужной масти (исключая джокеров)
            const suitCards = this.myHand.map((card, i) => ({ card, index: i }))
                .filter(({ card }) => card.suit === suit && !card.isSixSpades);

            if (suitCards.length > 0) {
                let validIndex = -1;

                if (cardType === 'high') {
                    // ✅ Находим ОДНУ старшую карту
                    const maxCard = suitCards.reduce((max, current) =>
                        current.card.value > max.card.value ? current : max
                    );
                    validIndex = maxCard.index;
                    console.log(`🔍 Клиент: условие джокера → валидна только ${maxCard.card.rank}${maxCard.card.suit}`);
                } else if (cardType === 'low') {
                    // ✅ Находим ОДНУ младшую карту
                    const minCard = suitCards.reduce((min, current) =>
                        current.card.value < min.card.value ? current : min
                    );
                    validIndex = minCard.index;
                    console.log(`🔍 Клиент: условие джокера → валидна только ${minCard.card.rank}${minCard.card.suit}`);
                }

                // ✅ Возвращаем ОДНУ карту + джокеры
                const jokerIndices = this.myHand.map((_, i) => i).filter(i => this.myHand[i].isSixSpades);
                return [validIndex, ...jokerIndices].filter(i => i !== -1);
            }

            // Если нет карт нужной масти — можно сбрасывать любые
            return this.myHand.map((_, i) => i);
        }

        // ✅ Обычная логика (без условия джокера)
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

        // ✅ Если ждём выбор джокера — показываем статус
        if (this.gameState.waitingForJokerChoice) {
            const msg = document.createElement('div');
            msg.className = 'message warning';
            msg.textContent = '🃏 Ожидание выбора силы джокера...';
            area.appendChild(msg);
            return;
        }

        if (this.gameState.gameState === 'finished') {
            this.showResults();
            return;
        }

        // updateControlArea():
        if (this.gameState.jokerCondition) {
            const { suit, cardType } = this.gameState.jokerCondition;
            const conditionText = cardType === 'high' ? 'Старшие' : 'Младшие';
            const conditionBar = document.getElementById('jokerConditionBar');
            if (conditionBar) {
                conditionBar.textContent = `🃏 Джокер: ${suit} ${conditionText} карты`;
                conditionBar.classList.remove('hidden');
            }
        }

        // В updateControlArea(), после проверки jokerCondition:
        if (this.gameState.jokerCondition && this.gameState.jokerPlayerIdx !== this.playerIdx) {
            const { suit, cardType } = this.gameState.jokerCondition;
            const suitCards = this.myHand.filter(c => c.suit === suit && !c.isSixSpades);

            if (suitCards.length > 0) {
                let requiredCard;
                if (cardType === 'high') {
                    requiredCard = suitCards.reduce((max, c) => c.value > max.value ? c : max);
                } else {
                    requiredCard = suitCards.reduce((min, c) => c.value < min.value ? c : min);
                }

                const msgDiv = document.createElement('div');
                msgDiv.className = 'message warning';
                msgDiv.innerHTML = `🃏 Джокер требует: <strong>${requiredCard.rank}${requiredCard.suit}</strong> (единственная ${cardType === 'high' ? 'старшая' : 'младшая'} карта)`;
                area.appendChild(msgDiv);
            }
        }

        const mode = this.gameState.mode;
        const isBlind = mode === '👁️ Слепая';
        const isBidding = this.gameState.gameState === 'bidding';

        // ✅ ПРАВИЛЬНОЕ ОПРЕДЕЛЕНИЕ ЧЕЙ ХОД
        const currentPlayerIdx = this.getCurrentPlayerIdx();
        const isMyTurn = currentPlayerIdx === this.playerIdx;

        // ✅ В СЛЕПОЙ — ПРОВЕРЯЕМ СДЕЛАЛИ ЛИ МЫ СТАВКУ
        const myPlayerData = this.gameState.players[this.playerIdx];
        const hasMadeBid = myPlayerData?.hasBid || false;

        // ✅ ПОКАЗЫВАЕМ ТОРГОВЛЮ ПЕРВОЙ (даже если рука пустая в Слепой!)
        if (isBidding && isMyTurn) {
            console.log('📢 Показываем торговлю');
            this.showBiddingInterface(area);
            return;
        }

        // ✅ ПРОВЕРКА НАЛИЧИЯ РУКИ (только если не торговля)
        if (!this.myHand || this.myHand.length === 0) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'message';

            if (isBlind && !hasMadeBid) {
                msgDiv.textContent = '👁️ СЛЕПАЯ — сделайте ставку чтобы увидеть карты!';
            } else {
                msgDiv.textContent = '⏳ Ожидание карт...';
            }

            area.appendChild(msgDiv);
            console.log('⚠️ myHand пустой!');
            return;
        }

        // ✅ В СЛЕПОЙ — СКРЫВАЕМ КАРТЫ ДО СТАВКИ
        if (isBlind && !hasMadeBid) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'message warning';
            msgDiv.innerHTML = `👁️ СЛЕПАЯ — карты скрыты!<br>Сделайте ставку чтобы увидеть свои карты`;
            area.appendChild(msgDiv);
        } else if (isBlind && this.myHand && this.myHand.length > 0) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'message warning';
            msgDiv.innerHTML = `👁️ СЛЕПАЯ — карты скрыты!<br>У вас карт: ${this.myHand.length}`;
            area.appendChild(msgDiv);
        }

        // ✅ ТОРГОВЛЯ
        if (isBidding && isMyTurn) {
            console.log('📢 Показываем торговлю');
            this.showBiddingInterface(area);
            return;
        }

        // ✅ РОЗЫГРЫШ
        if (this.gameState.gameState === 'playing') {
            if (isMyTurn) {
                console.log('🎴 Мой ход!');
                this.showPlayHints(area);
            } else {
                const msg = document.createElement('div');
                msg.className = 'message';
                const currentPlayer = this.gameState.players[currentPlayerIdx];
                msg.textContent = `⏳ ${currentPlayer?.name || '...'} ходит...`;
                area.appendChild(msg);
            }
            return;
        }

        // ✅ ОЖИДАНИЕ ТОРГОВЛИ
        if (isBidding) {
            const msg = document.createElement('div');
            msg.className = 'message';
            const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
            msg.textContent = `⏳ ${currentPlayer?.name || '...'} делает заявку...`;
            area.appendChild(msg);
            return;
        }

        // ✅ ПО УМОЛЧАНИЮ
        const msg = document.createElement('div');
        msg.className = 'message success';
        msg.textContent = `🎴 РОЗЫГРЫШ! Следите за ходом...`;
        area.appendChild(msg);
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

        const mode = this.gameState.mode;
        let ruleText = '🎴 ПЕРВЫЙ ХОД — ЛЮБАЯ КАРТА!';

        // ✅ СПЕЦИАЛЬНЫЕ ПОДСКАЗКИ ДЛЯ РЕЖИМОВ
        if (mode === '😈 Мизер') {
            ruleText = '😈 МИЗЕР! Старайтесь НЕ брать взятки!';
        } else if (mode === '🔥 Хапки') {
            ruleText = '🔥 ХАПКИ! Берите как можно больше взяток! (+20 за каждую)';
        }

        const cardsOnTableCount = this.gameState.cardsOnTable ? this.gameState.cardsOnTable.length : 0;
        if (cardsOnTableCount > 0 && this.gameState.leadSuit) {
            const sameSuitCards = this.myHand.filter(card => card.suit === this.gameState.leadSuit && !card.isSixSpades);

            if (sameSuitCards.length > 0) {
                ruleText = mode === '😈 Мизер'
                    ? `😈 МИЗЕР! ОБЯЗАН ходить в ${this.gameState.leadSuit}! (или 🃏)`
                    : `🎴 ОБЯЗАН ходить в ${this.gameState.leadSuit}! (или 🃏)`;
            } else if (mode !== '🃏 Бескозырка' && this.gameState.trumpSuit) {
                const trumpCards = this.myHand.filter(card => card.suit === this.gameState.trumpSuit && !card.isSixSpades);
                if (trumpCards.length > 0) {
                    ruleText = mode === '😈 Мизер'
                        ? `😈 МИЗЕР! Нет ${this.gameState.leadSuit} — ОБЯЗАН бить ${this.gameState.trumpSuit}! (или 🃏)`
                        : `🎴 Нет ${this.gameState.leadSuit} — ОБЯЗАН бить ${this.gameState.trumpSuit}! (или 🃏)`;
                } else {
                    ruleText = mode === '😈 Мизер'
                        ? `😈 МИЗЕР! Нет масти и козырей — СБРАСЫВАЙТЕ ЛЮБУЮ (мелкую)!`
                        : `🎴 Нет ${this.gameState.leadSuit} и козырей — СБРАСЫВАЙТЕ ЛЮБУЮ!`;
                }
            } else {
                ruleText = mode === '😈 Мизер'
                    ? `😈 МИЗЕР! Нет ${this.gameState.leadSuit} — СБРАСЫВАЙТЕ ЛЮБУЮ (мелкую)!`
                    : `🎴 Нет ${this.gameState.leadSuit} — СБРАСЫВАЙТЕ ЛЮБУЮ!`;
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

    // ✅ МЕТОД: Показать модальное окно выбора силы джокера
    showJokerChoiceModal(card, trickNumber, isFirstCard = false) {
        this.isProcessing = true;

        const modal = document.createElement('div');
        modal.className = 'joker-choice-modal';
        modal.id = 'jokerChoiceModal';

        // ✅ Выбор масти (только первый ход)
        const suitSelection = isFirstCard ? `
    <div class="joker-suit-selection">
        <div class="joker-suit-title">🎨 Выберите масть:</div>
        <div class="joker-suits">
            <button class="joker-suit-btn" data-suit="♠">♠</button>
            <button class="joker-suit-btn" data-suit="♥">♥</button>
            <button class="joker-suit-btn" data-suit="♦">♦</button>
            <button class="joker-suit-btn" data-suit="♣">♣</button>
        </div>
    </div>
    ` : '';

        // ✅ Выбор типа карт (только первый ход)
        const cardTypeSelection = isFirstCard ? `
    <div class="joker-cardtype-selection">
        <div class="joker-cardtype-title">📊 Какие карты должны сбросить:</div>
        <div class="joker-cardtype-options">
            <button class="joker-cardtype-btn" data-type="high" id="cardTypeHigh">
                <span class="cardtype-icon">⬆️</span>
                <span class="cardtype-text">Старшие карты</span>
                <span class="cardtype-desc">10, J, Q, K, A</span>
            </button>
            <button class="joker-cardtype-btn" data-type="low" id="cardTypeLow">
                <span class="cardtype-icon">⬇️</span>
                <span class="cardtype-text">Младшие карты</span>
                <span class="cardtype-desc">6, 7, 8, 9</span>
            </button>
        </div>
    </div>
    ` : '';

        modal.innerHTML = `
    <div class="joker-modal-content">
        <div class="joker-card joker">6♠🃏</div>
        <div class="joker-title">🃏 Джокер!</div>
        <div class="joker-question">${isFirstCard ? 'Ход джокером!' : 'Как использовать?'}</div>
        
        ${suitSelection}
        ${cardTypeSelection}
        
        <div class="joker-options">
            <button class="joker-btn joker-high" id="jokerHigh">
                <span class="joker-icon">⬆️</span>
                <span class="joker-text">Старшая карта</span>
                <span class="joker-desc">${isFirstCard ? 'Выиграть взятку' : 'Выиграть взятку'}</span>
            </button>
            <button class="joker-btn joker-low" id="jokerLow">
                <span class="joker-icon">⬇️</span>
                <span class="joker-text">Младшая карта</span>
                <span class="joker-desc">${isFirstCard ? 'Проиграть взятку' : 'Проиграть взятку'}</span>
            </button>
        </div>
        
        <div class="joker-info">Взятка #${trickNumber}${isFirstCard ? ' • Выберите масть, тип карт и силу' : ''}</div>
    </div>
    `;

        document.body.appendChild(modal);

        let selectedSuit = null;
        let selectedCardType = null;

        // ✅ Обработчики выбора масти
        if (isFirstCard) {
            const suitBtns = modal.querySelectorAll('.joker-suit-btn');
            suitBtns.forEach(btn => {
                btn.onclick = () => {
                    suitBtns.forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    selectedSuit = btn.dataset.suit;
                };
            });

            // ✅ Обработчики выбора типа карт
            const cardTypeBtns = modal.querySelectorAll('.joker-cardtype-btn');
            cardTypeBtns.forEach(btn => {
                btn.onclick = () => {
                    cardTypeBtns.forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    selectedCardType = btn.dataset.type;
                };
            });
        }

        // ✅ Обработчики кнопок силы
        document.getElementById('jokerHigh').onclick = () => {
            if (isFirstCard && !selectedSuit) {
                alert('⚠️ Выберите масть!');
                return;
            }
            if (isFirstCard && !selectedCardType) {
                alert('⚠️ Выберите тип карт (старшие/младшие)!');
                return;
            }
            this.sendJokerChoice('high', selectedSuit, selectedCardType);
            modal.remove();
        };

        document.getElementById('jokerLow').onclick = () => {
            if (isFirstCard && !selectedSuit) {
                alert('⚠️ Выберите масть!');
                return;
            }
            if (isFirstCard && !selectedCardType) {
                alert('⚠️ Выберите тип карт (старшие/младшие)!');
                return;
            }
            this.sendJokerChoice('low', selectedSuit, selectedCardType);
            modal.remove();
        };

        setTimeout(() => {
            modal.style.opacity = '1';
            modal.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 10);
    }

    // ✅ МЕТОД: Отправить выбор силы джокера (и масти если первый ход)
    sendJokerChoice(choice, suit = null, cardType = null) {
        console.log('🃏 Отправка выбора джокера:', { choice, suit, cardType });

        this.socket.emit('jokerChoice', {
            roomId: this.roomId,
            playerIdx: this.playerIdx,
            choice: choice,
            suit: suit,
            cardType: cardType  // ✅ Новый параметр
        });

        setTimeout(() => {
            this.isProcessing = false;
        }, 500);
    }
}

const game = new OnlinePokerGame();

