// Shared deck/card implementation for all game modes.
// Keep this file dependency-free so it can be reused by both modules.

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALUES = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

const TOTAL_CARDS = 36;

class Card {
    constructor(suit, rank, isSixSpades = false) {
        this.suit = suit;
        this.rank = rank;
        this.isSixSpades = isSixSpades;
        this.value = VALUES[rank] || 100;
        // Used by the poker joker (6♠)
        this.jokerPower = null; // 'high' | 'low' | null
    }

    toJSON() {
        return {
            suit: this.suit,
            rank: this.rank,
            isSixSpades: this.isSixSpades,
            value: this.value,
            jokerPower: this.jokerPower,
        };
    }
}

class Deck {
    constructor() {
        this.cards = [];
        this.createDeck();
    }

    createDeck() {
        this.cards = [];
        for (const suit of SUITS) {
            for (const rank of RANKS) {
                const isSixSpades = suit === '♠' && rank === '6';
                this.cards.push(new Card(suit, rank, isSixSpades));
            }
        }
        this.shuffle();
    }

    shuffle() {
        // Two passes shuffle (keeps behavior consistent with server.js)
        for (let pass = 0; pass < 2; pass++) {
            for (let i = this.cards.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
            }
        }
    }

    deal() {
        return this.cards.pop();
    }
}

module.exports = {
    SUITS,
    RANKS,
    VALUES,
    TOTAL_CARDS,
    Card,
    Deck,
};

