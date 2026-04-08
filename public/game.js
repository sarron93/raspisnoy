const SUITS = ['♠', '♥', '♦', '♣'];

const SUITS_VIEW_MAP = {
  '♠': '♠️',
  '♥': '♥️',
  '♦': '♦️',
  '♣': '♣️',
};

const SUITS_SORT_VALUE = {
  '♠': 300,
  '♥': 200,
  '♦': 100,
  '♣': 0,
};

// Старшинство для "Козла": 6 < 7 < 8 < 9 < В(=J) < Д(=Q) < К < 10 < Т(=A)
const KOZEL_RANK_ORDER = { '6': 0, '7': 1, '8': 2, '9': 3, 'J': 4, 'Q': 5, 'K': 6, '10': 7, 'A': 8 };


const PLAYERS_POSITIONS = {
    2: [0,3],
    3: [0,2,4],
    4: [0,1,3,5],
    5: [0,1,2,4,5]
}
class OnlinePokerGame {
    constructor() {
        this.socket = io();
        this.gameType = 'poker';
        this.roomId = null;
        this.playerIdx = null;
        this.gameState = null;
        this.myHand = [];
        this.isProcessing = false;
        this.availableModes = [];
        this._lastSentModeKeys = null;

        // 🐐 Козел: выбор нескольких карт за один ход (клиентская логика)
        this.kozelSelectedIdxs = [];
        this.kozelSuitLock = null; // только для атаки: масть для не-джокеров
        this._kozelSelectionKey = null; // чтобы сбрасывать выделение при смене фазы/хода

        // ✅ РЕКОННЕКТ ЛОГИКА
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000; // 1 секунда
        this.isReconnecting = false;
        this.wasInGame = false;

        this.setupSocketListeners();
    }

    getSelectedGameType() {
        const select = document.getElementById('gameTypeSelect');
        return select?.value || 'poker';
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

        // ✅ ОБРАБОТЧИК: Статистика сервера
        this.socket.on('serverStats', (stats) => {
            console.log('📊 Статистика сервера:', stats);

            const playersEl = document.getElementById('statPlayers');
            const roomsEl = document.getElementById('statRooms');

            if (playersEl) {
                playersEl.textContent = stats.totalPlayersConnected || 0;
            }

            if (roomsEl) {
                roomsEl.textContent = stats.activeRooms || 0;
            }
        });

        // ✅ ОБРАБОТЧИК: Список доступных комнат
        this.socket.on('availableRooms', (rooms) => {
            console.log('🏠 Доступные комнаты:', rooms);
            this.updateRoomsList(rooms);
        });

        // ✅ Запрашиваем статистику и список комнат при подключении
        this.socket.emit('getServerStats');
        this.socket.emit('getAvailableRooms');

        // ✅ Обновляем список комнат каждые 5 секунд
        setInterval(() => {
            if (document.getElementById('menuScreen')?.classList.contains('active')) {
                this.socket.emit('getAvailableRooms');
            }
        }, 5000);


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

        this.socket.on('roomCreated', ({ roomId, playerIdx, state }) => {
            console.log('🏠 Комната создана:', roomId);
            this.gameType = state?.gameType || this.getSelectedGameType();
            this.roomId = roomId;
            this.playerIdx = playerIdx;
            this.wasInGame = false;
            if (state) this.gameState = state;
            document.getElementById('displayRoomId').textContent = roomId;
            this.showScreen('waitingScreen');
            this.updatePlayersList();
        });

        this.socket.on('roomJoined', ({ roomId, playerIdx, state }) => {
            console.log('🚪 В комнате:', roomId);
            this.gameType = state?.gameType || this.getSelectedGameType();
            this.roomId = roomId;
            this.playerIdx = playerIdx;
            this.wasInGame = false;
            if (state) this.gameState = state;
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

        this.socket.on('roomUpdated', (state) => {
            console.log('⚙️ Комната обновлена');
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

            if (state.hand !== undefined) {
                this.myHand = state.hand;
            }

            this.gameState = state;

            // Для Козла снимаем блокировку после любого серверного апдейта.
            if (state.gameType === 'kozel') {
                this.isProcessing = false;
                if (this.playCardTimeout) {
                    clearTimeout(this.playCardTimeout);
                    this.playCardTimeout = null;
                }
            }

            // ✅ Разблокируем только если взятка завершена
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
            console.log('🃏 Карт в руке:', state.hand?.length || 0);

            this.gameState = state;
            this.myHand = this.prepareCards(state.hand)

            console.log('✅ myHand обновлён:', this.myHand.length, 'карт');

            // ✅ Разблокируем только если не ожидание джокера
            if (!state.waitingForJokerChoice) {
                this.isProcessing = false;
                if (this.playCardTimeout) {
                    clearTimeout(this.playCardTimeout);
                    this.playCardTimeout = null;
                }
            }

            if (state.gameType === 'kozel') {
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

            // ✅ РАЗБЛОКИРУЕМ интерфейс при ошибке!
            this.isProcessing = false;
            if (this.playCardTimeout) {
                clearTimeout(this.playCardTimeout);
                this.playCardTimeout = null;
            }

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
            this.myHand = this.prepareCards(state.hand)
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
    
    getSortValue(card) {
        const value = card.value + SUITS_SORT_VALUE[card.suit];
        const trumpValue = card.suit === this.gameState.trumpSuit ? 1000 : 0;
        const jokerValue =  card.isSixSpades ? 2000 : 0;

        return value + trumpValue + jokerValue
    }

    prepareCards(hand) {
        if(!hand){
            return []
        }
        return hand
        .map((c, id) => ({ ...c, id }))
        .sort((a, b) => this.getSortValue(b) - this.getSortValue(a));
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
        this.gameType = this.getSelectedGameType();

        this.socket.emit('createRoom', {
            playerName,
            maxPlayers: this.gameType === 'kozel' ? 2 : 4,
            testMode: testMode,  // ✅ Передаём флаг
            gameType: this.gameType
        });
    }

    joinRoom() {
        const playerName = document.getElementById('playerName').value.trim();
        const roomId = document.getElementById('roomIdInput').value.trim().toUpperCase();
        if (!playerName) { alert('Введите ваше имя!'); return; }
        if (!roomId) { alert('Введите код комнаты!'); return; }
        this.gameType = this.getSelectedGameType();
        this.socket.emit('joinRoom', { roomId, playerName, gameType: this.gameType });
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

    playCard(cardIdx, action = null) {
        if (this.isProcessing) {
            console.log('⚠️ Уже обрабатывается запрос, игнорируем');
            return;
        }

        if (!this.myHand || this.myHand.length === 0) {
            console.warn('⚠️ Нет карт в руке');
            return;
        }

        const isKozel = this.gameState?.gameType === 'kozel';
        const cardIdxs = Array.isArray(cardIdx) ? cardIdx : [cardIdx];

        if (cardIdxs.length === 0 || cardIdxs.some((i) => i < 0 || i >= this.myHand.length)) {
            console.warn('⚠️ Неверные индексы карты:', cardIdxs);
            return;
        }

        console.log('🃏 playCard вызван:', { cardIdx: isKozel ? cardIdxs : cardIdxs[0], action, playerIdx: this.playerIdx });

        // ✅ БЛОКИРУЕМ интерфейс СРАЗУ, до отправки
        this.isProcessing = true;

        this.playCardTimeout = setTimeout(() => {
            console.warn('⚠️ Таймаут хода, сброс isProcessing');
            this.isProcessing = false;
            this.playCardTimeout = null;
        }, 5000);

        this.socket.emit('playCard', {
            roomId: this.roomId,
            playerIdx: this.playerIdx,
            cardIdx: isKozel ? cardIdxs : cardIdxs[0],
            action: action
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

        // ✅ Настройки комнаты: режим
        this.updateRoomSettings();

        const startBtn = document.getElementById('startBtn');
        if (this.playerIdx === 0 && this.gameState.players.length >= 2) {
            startBtn.classList.remove('hidden');
        } else {
            startBtn.classList.add('hidden');
        }
    }

    updateRoomSettings() {
        const container = document.getElementById('modeCheckboxes');
        const help = document.getElementById('modeHelp');
        if (!container || !help || !this.gameState) return;
        if (this.gameState.gameType === 'kozel') {
            container.innerHTML = '<div style="opacity: 0.9;">🐐 Козел 1×1 (фиксированные правила)</div>';
            help.textContent = 'В этом режиме нет выбора кампании.';
            return;
        }

        const isHost = this.playerIdx === 0;
        const availableModes = Array.isArray(this.gameState.availableModes) ? this.gameState.availableModes : [];
        const selectedModeKeys = Array.isArray(this.gameState.selectedModeKeys)
            ? this.gameState.selectedModeKeys
            : [];

        // ✅ Рендерим чекбоксы (и поддерживаем idempotent updates)
        const nextKeys = availableModes.map(m => m.key);
        const currentKeys = [...container.querySelectorAll('input[type="checkbox"][data-mode-key]')].map(i => i.dataset.modeKey);
        const keysChanged =
            currentKeys.length !== nextKeys.length ||
            currentKeys.some((k, i) => k !== nextKeys[i]);

        if (keysChanged) {
            container.innerHTML = '';

            const list = document.createElement('div');
            list.className = 'mode-list'

            availableModes.forEach(({ key, name }) => {
                const row = document.createElement('label');
                row.className = 'mode-item'
                if(isHost){
                    row.style.cursor = 'pointer'
                }

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.dataset.modeKey = key;
                // cb.disabled = !isHost;
                cb.checked = selectedModeKeys.includes(key);

                const text = document.createElement('span');
                text.textContent = name;

                row.appendChild(cb);
                row.appendChild(text);
                list.appendChild(row);
            });

            container.appendChild(list);
        } else {
            // ✅ Обновляем checked/disabled без пересоздания DOM
            const inputs = [...container.querySelectorAll('input[type="checkbox"][data-mode-key]')];
            inputs.forEach((cb) => {
                // cb.disabled = !isHost;
                cb.checked = selectedModeKeys.includes(cb.dataset.modeKey);
            });
        }

        help.textContent = isHost
            ? 'Выберите режимы кампании и нажмите «Начать игру».'
            : 'Режимы выбирает создатель комнаты.';

        if (!container.dataset.bound) {
            container.addEventListener('change', () => {
                if (!this.roomId) return;

                const inputs = [...container.querySelectorAll('input[type="checkbox"][data-mode-key]')];
                const modeKeys = inputs.filter(i => i.checked).map(i => i.dataset.modeKey);

                // ✅ Нельзя оставить пусто
                if (modeKeys.length === 0) {
                    const first = inputs[0];
                    if (first) first.checked = true;
                    return;
                }

                const normalized = [...modeKeys].sort().join(',');
                if (this._lastSentModeKeys === normalized) return;
                this._lastSentModeKeys = normalized;

                this.socket.emit('setRoomModes', { roomId: this.roomId, modeKeys });
            });
            container.dataset.bound = '1';
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
        <span>${this.gameState.gameType === 'kozel' ? '🐐 Козел' : '🎰 Покер'}</span>
        <span>|</span>
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

    }

    getPlayerPosition(idx){
        const playersAmount = this.gameState.players.length;
        const playerPos = (idx - this.playerIdx + playersAmount) % playersAmount;
        return PLAYERS_POSITIONS[playersAmount][playerPos]
    }

    updatePlayersArea() {
        const area = document.getElementById('playersArea');
        area.innerHTML = '';

        this.gameState.players.forEach((player, idx) => {
            const wrapper = document.createElement('div');
            wrapper.className = `player-wrapper player-position-${this.getPlayerPosition(idx)}`;

            if (idx === this.playerIdx) wrapper.classList.add('active');
            if (player.isDealer) wrapper.classList.add('dealer');

            // ✅ ДЛЯ ТЕКУЩЕГО ИГРОКА — ИСПОЛЬЗУЕМ this.myHand
            if (idx === this.playerIdx && this.myHand && this.myHand.length > 0) {
                const isBidding = this.gameState.gameState === 'bidding';
                const currentPlayerIdx = this.getCurrentPlayerIdx();
                const isMyTurn = this.gameState.gameState === 'playing' && currentPlayerIdx === this.playerIdx;
                const cardsClickable = !isBidding && isMyTurn;

                const validIndices = cardsClickable ? this.getValidClientIndices() : [];

                const fullHand = document.createElement('div');
                fullHand.className = 'player-full-hand';

                this.myHand.forEach((card, cardIdx) => {
                    const miniCard = this.createPlayerCardMini(
                        card,
                        cardsClickable,
                        validIndices.includes(cardIdx) || isBidding
                    );
                    fullHand.appendChild(miniCard);
                });
            wrapper.appendChild(fullHand);
            } 


            const playerCard = document.createElement('div');
            playerCard.className = 'player-card';
            if (player.isDealer) playerCard.classList.add('dealer');

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

    createPlayerCardMini(card, isClickable = false, isValid = false) {
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

        // 🐐 Козел: подсветка выделенных карт
        const isKozelCard = this.gameState?.gameType === 'kozel';
        const isSelected = isKozelCard && Array.isArray(this.kozelSelectedIdxs) && this.kozelSelectedIdxs.includes(card.id);
        if (isSelected) {
            cardDiv.style.outline = '2px solid #4ecca3';
            cardDiv.style.outlineOffset = '2px';
        } else {
            cardDiv.style.outline = '';
            cardDiv.style.outlineOffset = '';
        }

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

            // 🐐 КОЗЕЛ: много-картный ход через выделение
            if (this.gameState?.gameType === 'kozel') {
                const attackCount = this.gameState.cardsOnTable?.length || 0;
                const isDefensePhase = attackCount > 0;
                const idx = card.id;

                const toggleIdx = (arr, val) => {
                    const i = arr.indexOf(val);
                    if (i !== -1) arr.splice(i, 1);
                    else arr.push(val);
                };

                if (!isDefensePhase) {
                    // Атака: не-джокеры должны быть одной масти
                    const isJoker = card.isSixSpades;
                    const selected = this.kozelSelectedIdxs.includes(idx);

                    if (selected) {
                        toggleIdx(this.kozelSelectedIdxs, idx);
                    } else {
                        if (!isJoker) {
                            if (this.kozelSuitLock && card.suit !== this.kozelSuitLock) {
                                return;
                            }
                            if (!this.kozelSuitLock) {
                                this.kozelSuitLock = card.suit;
                            }
                        }
                        this.kozelSelectedIdxs.push(idx);
                    }

                    // Пересчитываем suitLock по оставшимся не-джокерам
                    const nonJokers = this.kozelSelectedIdxs
                        .map((i) => this.myHand.find(c => c.id === i))
                        .filter((c) => c && !c.isSixSpades);
                    this.kozelSuitLock = nonJokers.length > 0 ? nonJokers[0].suit : null;
                } else {
                    // Защита: количество карт = количеству атакующих
                    const requiredCount = attackCount;
                    const selected = this.kozelSelectedIdxs.includes(idx);

                    if (selected) {
                        toggleIdx(this.kozelSelectedIdxs, idx);
                    } else {
                        if (this.kozelSelectedIdxs.length >= requiredCount) return;
                        this.kozelSelectedIdxs.push(idx);
                    }
                }

                // Обновляем UI (кнопки и подсветку выделения)
                this.updatePlayersArea();
                this.updateControlArea();
                return;
            }

            // 🎯 ПОКЕР (старое поведение)
            this.playCard(card.id);
        };
        cardDiv.style.cursor = 'pointer';
        cardDiv.title = 'Нажмите чтобы походить';

        return cardDiv;
    }

    canKozelBeat(attackCard, defendCard) {
        if (!attackCard || !defendCard) return false;
        if (defendCard.isSixSpades) return true; // 6♠ - джокер

        // Если атаковали пиками — отбиваем ТОЛЬКО пиками (по старшинству)
        if (attackCard.suit === '♠') {
            return defendCard.suit === '♠' &&
                KOZEL_RANK_ORDER[defendCard.rank] > KOZEL_RANK_ORDER[attackCard.rank];
        }

        // Та же масть
        if (defendCard.suit === attackCard.suit) {
            return KOZEL_RANK_ORDER[defendCard.rank] > KOZEL_RANK_ORDER[attackCard.rank];
        }

        // Козырь (если козыря нет — this.gameState.trumpSuit будет null)
        if (this.gameState?.trumpSuit && defendCard.suit === this.gameState.trumpSuit) {
            if (attackCard.suit === this.gameState.trumpSuit) {
                return KOZEL_RANK_ORDER[defendCard.rank] > KOZEL_RANK_ORDER[attackCard.rank];
            }
            return true; // любой козырь бьет не-козырную атаку
        }

        return false;
    }

    resetKozelSelection() {
        this.kozelSelectedIdxs = [];
        this.kozelSuitLock = null;
        // key выставляется в updateControlArea (там же происходит сброс при смене фазы)
        // Чтобы UI не показывал старое выделение до прихода gameState.
        this.updatePlayersArea();
        this.updateControlArea();
    }

    clientHasHammer() {
        if (!this.myHand || this.myHand.length < 4) return false;
        const jokerCount = this.myHand.filter(c => c.isSixSpades).length;
        const nonJokers = this.myHand.filter(c => !c.isSixSpades);
        for (const suit of ['♠', '♥', '♦', '♣']) {
            if (nonJokers.filter(c => c.suit === suit).length + jokerCount >= 4) return true;
        }
        return false;
    }

    clientHasMoscow() {
        if (!this.myHand || this.myHand.length < 4) return false;
        const POINTS = { 'A': 11, '10': 10, 'K': 4, 'Q': 3, 'J': 2 };
        return this.myHand.reduce((sum, c) => sum + (c.isSixSpades ? 11 : (POINTS[c.rank] || 0)), 0) >= 41;
    }

    isKozelComboBlocked() {
        const attackCount = this.gameState.cardsOnTable?.length || 0;
        const isMyTurn = this.getCurrentPlayerIdx() === this.playerIdx;
        if (attackCount === 0 && !isMyTurn) {
            const opponentIdx = (this.playerIdx + 1) % 2;
            const combos = this.gameState.playerCombos;
            if (combos && (combos[opponentIdx]?.hammer || combos[opponentIdx]?.moscow)) return true;
        }
        return false;
    }

    submitKozelCombo(comboType) {
        if (this.isProcessing) return;
        this.isProcessing = true;
        this.playCardTimeout = setTimeout(() => {
            this.isProcessing = false;
        }, 5000);
        this.socket.emit('playCombo', {
            roomId: this.roomId,
            playerIdx: this.playerIdx,
            comboType,
        });
    }

    submitKozelAttack() {
        if (this.isProcessing) return;
        if (!Array.isArray(this.kozelSelectedIdxs) || this.kozelSelectedIdxs.length === 0) return;

        const cardIdxs = [...this.kozelSelectedIdxs];
        this.resetKozelSelection();
        this.playCard(cardIdxs, 'attack');
    }

    submitKozelDefense(action = 'discard') {
        if (this.isProcessing) return;

        const attackCount = this.gameState.cardsOnTable?.length || 0;
        if (!Array.isArray(this.kozelSelectedIdxs) || this.kozelSelectedIdxs.length !== attackCount) return;

        const cardIdxs = [...this.kozelSelectedIdxs];
        this.resetKozelSelection();
        this.playCard(cardIdxs, action);
    }

    canKozelBeatAllFromSelection() {
        const attackEntries = this.gameState.cardsOnTable || [];
        const attackSuit = this.gameState.kozelAttackSuit || '♠';

        const attackCardsNorm = attackEntries.map(({ card }) => {
            if (card.isSixSpades) {
                return { suit: attackSuit, rank: 'A', isSixSpades: false };
            }
            return { suit: card.suit, rank: card.rank, isSixSpades: false };
        });

        const defenseCards = (this.kozelSelectedIdxs || [])
            .map((i) => this.myHand.find(c => c.id === i))
            .filter(Boolean);

        if (attackCardsNorm.length === 0) return false;
        if (defenseCards.length !== attackCardsNorm.length) return false;

        const n = attackCardsNorm.length;
        const used = Array(n).fill(false);

        const dfs = (attackIdx) => {
            if (attackIdx >= n) return true;
            for (let defendIdx = 0; defendIdx < n; defendIdx++) {
                if (used[defendIdx]) continue;
                const defendCard = defenseCards[defendIdx];
                if (this.canKozelBeat(attackCardsNorm[attackIdx], defendCard)) {
                    used[defendIdx] = true;
                    if (dfs(attackIdx + 1)) return true;
                    used[defendIdx] = false;
                }
            }
            return false;
        };

        return dfs(0);
    }

    showKozelDefenseChoiceModal({ attackCard, defendCard, canBeat, cardId }) {
        // Защита только когда мы реально отвечаем (иначе кнопки будут бессмысленны)
        const modalId = 'kozelDefenseChoiceModal';
        const existing = document.getElementById(modalId);
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.className = 'joker-choice-modal'; // используем похожий стиль
        modal.id = modalId;
        modal.style.zIndex = '1000';

        const attackText = attackCard ? `${attackCard.rank}${attackCard.suit}` : '-';
        let defendText = '-';
        if (defendCard) {
            defendText = defendCard.isSixSpades ? '6♠🃏' : `${defendCard.rank}${defendCard.suit}`;
        }

        const buttonsHtml = canBeat
            ? `
                <button class="btn btn-primary" style="margin: 8px;" id="${modalId}-beat">Отбить</button>
                <button class="btn btn-secondary" style="margin: 8px;" id="${modalId}-discard">Скинуть</button>
              `
            : `
                <button class="btn btn-primary" style="margin: 8px;" id="${modalId}-discard">Скинуть</button>
              `;

        modal.innerHTML = `
            <div class="joker-modal-content">
                <div class="joker-title">🐐 Ответ на атаку</div>
                <div class="joker-info">Атака: <strong>${attackText}</strong></div>
                <div class="joker-info">Вы выбрали: <strong>${defendText}</strong></div>
                <div class="joker-question" style="margin-top: 10px;">Что делаем?</div>
                <div class="joker-options">${buttonsHtml}</div>
            </div>
        `;

        document.body.appendChild(modal);

        const beatBtn = document.getElementById(`${modalId}-beat`);
        const discardBtn = document.getElementById(`${modalId}-discard`);

        if (beatBtn) {
            beatBtn.onclick = () => {
                this.playCard(cardId, 'beat');
                modal.remove();
            };
        }

        if (discardBtn) {
            discardBtn.onclick = () => {
                this.playCard(cardId, 'discard');
                modal.remove();
            };
        }

        // Небольшая анимация как у джокера (если стили есть)
        setTimeout(() => {
            modal.style.opacity = '1';
            modal.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 10);
    }

    updateCardsOnTable() {
        const area = document.getElementById('cardsOnTable');
        area.innerHTML = '';
        area.style.display = '';
        area.style.flexDirection = '';
        area.style.alignItems = '';
        area.style.flexWrap = '';
        area.style.justifyContent = '';

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

        const trickComplete = this.gameState.cardsOnTable.some(e => e.trickComplete);

        // Для козла показываем атаку и защиту раздельно
        if (this.gameState.gameType === 'kozel' && this.gameState.cardsOnTable.length > 0) {
            area.style.display = 'flex';
            area.style.flexDirection = 'row';
            area.style.alignItems = 'center';
            area.style.flexWrap = 'wrap';
            area.style.justifyContent = 'center';
            const attackCards = this.gameState.cardsOnTable.filter(e => !e.isDefense);
            const defenseCards = this.gameState.cardsOnTable.filter(e => e.isDefense);

            const renderGroup = (entries, label) => {
                if (entries.length === 0) return;
                const group = document.createElement('div');
                group.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;';

                const lbl = document.createElement('div');
                lbl.style.cssText = 'font-size:0.75em;color:rgba(255,255,255,0.5);margin-bottom:2px;';
                lbl.textContent = label;
                group.appendChild(lbl);

                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:6px;';
                entries.forEach(({ playerIdx, card }) => {
                    const div = this.createCardElement(card);
                    if (trickComplete) div.style.opacity = '0.6';
                    const player = this.gameState.players[playerIdx];
                    const playerName = player.name.length > 8 ? player.name.substring(0, 8) + '…' : player.name;
                    const badge = document.createElement('div');
                    badge.className = `player-badge ${player.isDealer ? 'dealer' : ''}`;
                    badge.innerHTML = `${player.isDealer ? '👑 ' : ''}${playerName}`;
                    div.appendChild(badge);
                    row.appendChild(div);
                });
                group.appendChild(row);
                area.appendChild(group);
            };

            renderGroup(attackCards, 'атака');
            if (defenseCards.length > 0) {
                const sep = document.createElement('div');
                sep.style.cssText = 'display:flex;align-items:center;color:rgba(255,255,255,0.3);font-size:1.2em;padding:0 4px;';
                sep.textContent = '→';
                area.appendChild(sep);
                renderGroup(defenseCards, 'защита');
            }

            if (trickComplete && this.gameState.lastTrickWinner) {
                const winner = document.createElement('div');
                winner.style.cssText = 'font-size:0.8em;color:#4ecca3;grid-column:1/-1;text-align:center;margin-top:4px;';
                winner.textContent = `✅ Взял: ${this.gameState.lastTrickWinner.name}`;
                area.appendChild(winner);
            }
            return;
        }

        this.gameState.cardsOnTable.forEach(({ playerIdx, card }, index) => {
            const div = this.createCardElement(card);

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
    createCardElement(card) {
        const cardDiv = document.createElement('div');
        const cardClass = card.isSixSpades ? 'joker' :
        card.suit === '♥' || card.suit === '♦' ? 'hearts' : 'spades';

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

        return cardDiv;
    }

    getCurrentPlayerIdx() {
        if (!this.gameState) {
            console.log('❌ gameState is null');
            return null;
        }
        if (this.gameState.gameType === 'kozel') {
            return this.gameState.currentPlayer;
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
        if (this.gameState?.gameType === 'kozel') {
            return this.myHand.map((_, i) => i);
        }

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
        if (this.gameState.gameType === 'kozel') {
            const currentPlayerIdx = this.getCurrentPlayerIdx();
            const isMyTurn = currentPlayerIdx === this.playerIdx;
            const isFinished = this.gameState.gameState === 'finished';
            const attackCount = this.gameState.cardsOnTable?.length || 0;
            const phase = attackCount === 0 ? 'attack' : 'defense';
            const key = `${this.gameState.gameState}:${attackCount}:${phase}`;

            // Сбрасываем выделение при смене фазы/хода
            if (this._kozelSelectionKey !== key) {
                this.kozelSelectedIdxs = [];
                this.kozelSuitLock = null;
                this._kozelSelectionKey = key;
            }

            if (isFinished) {
                const msg = document.createElement('div');
                msg.className = 'message success';
                msg.textContent = '🏁 Партия в Козла завершена';
                area.appendChild(msg);
                return;
            }

            // Экран итогов кона
            if (this.gameState.gameState === 'roundEnd' && this.gameState.roundSummary) {
                const s = this.gameState.roundSummary;
                const names = s.playerNames;
                const PENALTY_LABELS = { 0: '0 штрафов', 2: '+2 яйца', 4: '+4 яйца', 6: '+6 яиц' };

                let html = `<div style="text-align:center;padding:8px 0;">`;
                html += `<div style="font-size:1.1em;font-weight:bold;margin-bottom:12px;color:#4ecca3;">📊 Итоги кона</div>`;
                html += `<table style="width:100%;border-collapse:collapse;font-size:0.9em;">`;
                html += `<tr style="color:rgba(255,255,255,0.6);">
                    <th style="text-align:left;padding:4px 8px;"></th>
                    <th style="padding:4px 8px;">${names[0]}</th>
                    <th style="padding:4px 8px;">${names[1]}</th>
                </tr>`;
                html += `<tr>
                    <td style="padding:4px 8px;color:rgba(255,255,255,0.6);">Очков собрано</td>
                    <td style="text-align:center;padding:4px 8px;font-weight:bold;">${s.roundPoints[0]}</td>
                    <td style="text-align:center;padding:4px 8px;font-weight:bold;">${s.roundPoints[1]}</td>
                </tr>`;
                html += `<tr>
                    <td style="padding:4px 8px;color:rgba(255,255,255,0.6);">Штраф за кон</td>
                    <td style="text-align:center;padding:4px 8px;color:${s.penalties[0] > 0 ? '#ff6b6b' : '#4ecca3'};">
                        ${s.penalties[0] > 0 ? '+' + s.penalties[0] : '0'}
                    </td>
                    <td style="text-align:center;padding:4px 8px;color:${s.penalties[1] > 0 ? '#ff6b6b' : '#4ecca3'};">
                        ${s.penalties[1] > 0 ? '+' + s.penalties[1] : '0'}
                    </td>
                </tr>`;
                html += `<tr style="border-top:1px solid rgba(255,255,255,0.2);">
                    <td style="padding:6px 8px;color:rgba(255,255,255,0.6);">Всего яиц</td>
                    <td style="text-align:center;padding:6px 8px;font-size:1.1em;font-weight:bold;color:${s.totalPenalties[0] >= 12 ? '#ff6b6b' : '#fff'};">
                        ${s.totalPenalties[0]} / 12
                    </td>
                    <td style="text-align:center;padding:6px 8px;font-size:1.1em;font-weight:bold;color:${s.totalPenalties[1] >= 12 ? '#ff6b6b' : '#fff'};">
                        ${s.totalPenalties[1]} / 12
                    </td>
                </tr>`;
                html += `</table>`;
                if (s.isEggs) {
                    html += `<div style="margin-top:10px;color:#ffd700;font-weight:bold;">🥚 Яйца! Следующий кон ×2</div>`;
                }
                html += `</div>`;

                const summary = document.createElement('div');
                summary.innerHTML = html;
                area.appendChild(summary);

                const btn = document.createElement('button');
                btn.className = 'btn btn-primary';
                btn.style.marginTop = '12px';
                btn.textContent = '▶ Следующий кон';
                btn.onclick = () => {
                    this.socket.emit('kozelContinue', { roomId: this.roomId, playerIdx: this.playerIdx });
                };
                area.appendChild(btn);
                return;
            }

            if (!isMyTurn) {
                const msg = document.createElement('div');
                msg.className = 'message';
                msg.textContent = `⏳ ${this.gameState.players[currentPlayerIdx]?.name || 'Соперник'} ходит...`;
                area.appendChild(msg);

                // Показываем кнопки комбинаций, если они есть и не заблокированы приоритетом
                if (!this.isKozelComboBlocked()) {
                    const hasHammer = this.clientHasHammer();
                    const hasMoscow = this.clientHasMoscow();
                    if (hasHammer || hasMoscow) {
                        const comboRow = document.createElement('div');
                        comboRow.style.marginTop = '10px';
                        if (hasHammer) {
                            const btn = document.createElement('button');
                            btn.className = 'btn btn-primary';
                            btn.textContent = '🔨 Сходить молотку';
                            btn.onclick = () => this.submitKozelCombo('hammer');
                            comboRow.appendChild(btn);
                        }
                        if (hasMoscow) {
                            const btn = document.createElement('button');
                            btn.className = 'btn btn-primary';
                            btn.style.marginLeft = hasHammer ? '8px' : '';
                            btn.textContent = '🏙️ Сходить москву';
                            btn.onclick = () => this.submitKozelCombo('moscow');
                            comboRow.appendChild(btn);
                        }
                        area.appendChild(comboRow);
                    }
                }
                return;
            }

            // ПОЛЬЗОВАТЕЛЬ СВОЙ ХОД
            if (phase === 'attack') {
                const selectedCount = this.kozelSelectedIdxs.length;
                const suitText = this.kozelSuitLock ? ` (масть: ${this.kozelSuitLock})` : '';

                area.innerHTML = `
                    <div class="message success">
                        🐐 Выберите ${selectedCount > 0 ? `ещё/карт: ${selectedCount}` : 'карту(ы)'} одной масти${suitText}
                    </div>
                `;

                const controls = document.createElement('div');
                controls.style.marginTop = '10px';

                if (selectedCount > 0) {
                    const btn = document.createElement('button');
                    btn.className = 'btn btn-primary';
                    btn.textContent = `🃏 Ходить ${selectedCount} карт(ой)`;
                    btn.onclick = () => this.submitKozelAttack();
                    controls.appendChild(btn);
                } else {
                    const btn = document.createElement('button');
                    btn.className = 'btn btn-primary';
                    btn.textContent = '🃏 Выберите карты для атаки';
                    btn.classList.add('disabled');
                    controls.appendChild(btn);
                }

                const btnClear = document.createElement('button');
                btnClear.className = 'btn btn-secondary';
                btnClear.style.marginLeft = '8px';
                btnClear.textContent = 'Очистить выбор';
                btnClear.onclick = () => this.resetKozelSelection();
                controls.appendChild(btnClear);

                // Кнопки комбинаций в свой ход (молотка/москва — играть вместо обычного хода)
                const hasHammer = this.clientHasHammer();
                const hasMoscow = this.clientHasMoscow();
                if (hasHammer || hasMoscow) {
                    const sep = document.createElement('span');
                    sep.style.margin = '0 8px';
                    sep.textContent = '|';
                    controls.appendChild(sep);
                    if (hasHammer) {
                        const btn = document.createElement('button');
                        btn.className = 'btn btn-primary';
                        btn.textContent = '🔨 Молотка!';
                        btn.onclick = () => this.submitKozelCombo('hammer');
                        controls.appendChild(btn);
                    }
                    if (hasMoscow) {
                        const btn = document.createElement('button');
                        btn.className = 'btn btn-primary';
                        btn.style.marginLeft = '8px';
                        btn.textContent = '🏙️ Москва!';
                        btn.onclick = () => this.submitKozelCombo('moscow');
                        controls.appendChild(btn);
                    }
                }

                area.appendChild(controls);
                return;
            }

            // phase === 'defense'
            const requiredCount = attackCount;
            const selectedCount = this.kozelSelectedIdxs.length;

            if (selectedCount < requiredCount) {
                const msg = document.createElement('div');
                msg.className = 'message warning';
                msg.textContent = `🐐 Выберите ровно ${requiredCount} карт для отбития`;
                area.appendChild(msg);

                // Комбинации доступны и в фазе защиты (если ещё не выбрали карты)
                const hasHammerE = this.clientHasHammer();
                const hasMoscowE = this.clientHasMoscow();
                if (hasHammerE || hasMoscowE) {
                    const comboRow = document.createElement('div');
                    comboRow.style.marginTop = '8px';
                    if (hasHammerE) {
                        const btn = document.createElement('button');
                        btn.className = 'btn btn-primary';
                        btn.textContent = '🔨 Молотка!';
                        btn.onclick = () => this.submitKozelCombo('hammer');
                        comboRow.appendChild(btn);
                    }
                    if (hasMoscowE) {
                        const btn = document.createElement('button');
                        btn.className = 'btn btn-primary';
                        btn.style.marginLeft = hasHammerE ? '8px' : '';
                        btn.textContent = '🏙️ Москва!';
                        btn.onclick = () => this.submitKozelCombo('moscow');
                        comboRow.appendChild(btn);
                    }
                    area.appendChild(comboRow);
                }
                return;
            }

            // selectedCount === requiredCount
            const canBeatAll = this.canKozelBeatAllFromSelection();

            area.innerHTML = `
                <div class="message success">
                    🐐 Выберите действие для отбития: ${selectedCount}/${requiredCount}
                </div>
            `;

            const controls = document.createElement('div');
            controls.style.marginTop = '10px';

            if (canBeatAll) {
                const btnBeat = document.createElement('button');
                btnBeat.className = 'btn btn-primary';
                btnBeat.textContent = '🛡️ Отбить';
                btnBeat.onclick = () => this.submitKozelDefense('beat');
                controls.appendChild(btnBeat);

                const btnDiscard = document.createElement('button');
                btnDiscard.className = 'btn btn-secondary';
                btnDiscard.style.marginLeft = '8px';
                btnDiscard.textContent = '⤵️ Скинуть';
                btnDiscard.onclick = () => this.submitKozelDefense('discard');
                controls.appendChild(btnDiscard);
            } else {
                const btnDiscard = document.createElement('button');
                btnDiscard.className = 'btn btn-primary';
                btnDiscard.textContent = '⤵️ Скинуть';
                btnDiscard.onclick = () => this.submitKozelDefense('discard');
                controls.appendChild(btnDiscard);
            }

            const btnClear = document.createElement('button');
            btnClear.className = 'btn btn-secondary';
            btnClear.style.marginLeft = '8px';
            btnClear.textContent = 'Очистить выбор';
            btnClear.onclick = () => this.resetKozelSelection();
            controls.appendChild(btnClear);

            // Кнопки комбинаций в фазе защиты (можно переходить вместо защиты)
            const hasHammerD = this.clientHasHammer();
            const hasMoscowD = this.clientHasMoscow();
            if (hasHammerD || hasMoscowD) {
                const sep = document.createElement('span');
                sep.style.margin = '0 8px';
                sep.textContent = '|';
                controls.appendChild(sep);
                if (hasHammerD) {
                    const btn = document.createElement('button');
                    btn.className = 'btn btn-primary';
                    btn.textContent = '🔨 Молотка!';
                    btn.onclick = () => this.submitKozelCombo('hammer');
                    controls.appendChild(btn);
                }
                if (hasMoscowD) {
                    const btn = document.createElement('button');
                    btn.className = 'btn btn-primary';
                    btn.style.marginLeft = '8px';
                    btn.textContent = '🏙️ Москва!';
                    btn.onclick = () => this.submitKozelCombo('moscow');
                    controls.appendChild(btn);
                }
            }

            area.appendChild(controls);
            return;
        }

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
        const isKozel = this.gameState?.gameType === 'kozel';
        leaderboard.innerHTML = `<h2 style="color: #4ecca3; margin-bottom: 20px;">${isKozel ? '🐐 Итог по штрафам:' : '📊 Итоговые результаты:'}</h2>`;
        const sortedPlayers = [...this.gameState.players].sort((a, b) => isKozel ? a.penalties - b.penalties : b.score - a.score);
        const medals = ['🥇', '🥈', '🥉'];
        sortedPlayers.forEach((player, idx) => {
            const div = document.createElement('div');
            div.className = 'leaderboard-item';
            if (idx === 0) div.classList.add('winner');
            const medal = medals[idx] || '  ';
            const scoreText = isKozel
                ? `${player.penalties ?? 0} штрафных`
                : `${player.score} очков`;
            div.innerHTML = `<span style="font-size: 1.3em;">${medal}</span> ${idx + 1}. ${player.name} — <strong style="color: #4ecca3;">${scoreText}</strong>`;
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

    // ✅ МЕТОД: Обновление списка доступных комнат
    updateRoomsList(rooms) {
        const container = document.getElementById('roomsList');
        if (!container) return;
        const selectedType = this.getSelectedGameType();
        const filteredRooms = (rooms || []).filter((room) => (room.gameType || 'poker') === selectedType);

        if (!filteredRooms || filteredRooms.length === 0) {
            container.innerHTML = `
            <div class="rooms-empty">
                📭 Нет доступных комнат<br>
                <small>Создайте свою или подождите других игроков</small>
            </div>
        `;
            return;
        }

        container.innerHTML = filteredRooms.map(room => `
        <div class="room-item ${!room.hasSpace ? 'room-full' : ''}">
            <div class="room-info">
                <div class="room-id">${room.roomId}</div>
                <div class="room-details">
                    <span>${room.gameType === 'kozel' ? '🐐 Козел' : '🎰 Покер'}</span>
                    <span class="room-players">
                        <span class="room-players-icon">👥</span>
                        ${room.playerCount}/${room.maxPlayers}
                    </span>
                    ${room.testMode ? '<span class="room-test-badge">🧪 ТЕСТ</span>' : ''}
                </div>
            </div>
            <button 
                class="room-join-btn" 
                onclick="game.quickJoinRoom('${room.roomId}')"
                ${!room.hasSpace ? 'disabled' : ''}
            >
                ${room.hasSpace ? '🚪 Войти' : '⛔ Полная'}
            </button>
        </div>
    `).join('');
    }

    // ✅ МЕТОД: Быстрое присоединение к комнате
    quickJoinRoom(roomId) {
        const playerName = document.getElementById('playerName').value.trim();
        if (!playerName) {
            alert('⚠️ Введите ваше имя перед входом в комнату!');
            document.getElementById('playerName').focus();
            return;
        }

        console.log('🚪 Быстрый вход в комнату:', roomId);
        this.gameType = this.getSelectedGameType();
        this.socket.emit('joinRoom', { roomId, playerName, gameType: this.gameType });
    }
}

const game = new OnlinePokerGame();
