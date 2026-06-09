'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const EventEmitter = require('events');

const SPEAKER_SELECTION = {
  ROUND_ROBIN: 'round-robin',
  RANDOM: 'random',
  LLM_CHOICE: 'llm-choice',
  CUSTOM: 'custom',
};

const GROUP_CHAT_STATES = {
  IDLE: 'idle',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const MESSAGE_TYPES = {
  SPEECH: 'speech',
  SYSTEM: 'system',
  VOTE: 'vote',
  PROPOSAL: 'proposal',
};

const DEFAULT_OPTIONS = {
  maxParticipants: 20,
  maxMessages: 500,
  maxRounds: 20,
  speakerSelection: SPEAKER_SELECTION.ROUND_ROBIN,
  speakerFn: null,
  terminationCondition: null,
  summaryFn: null,
};

class GroupChat extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._participants = new BoundedMap(this._options.maxParticipants);
    this._messages = new BoundedArray(this._options.maxMessages);
    this._state = GROUP_CHAT_STATES.IDLE;
    this._currentSpeakerIndex = 0;
    this._round = 0;
    this._stats = {
      totalMessages: 0,
      totalRounds: 0,
      byParticipant: {},
      byType: {},
    };
  }

  get state() { return this._state; }
  get round() { return this._round; }
  get messageCount() { return this._messages.length; }

  addParticipant(agentId, metadata) {
    if (this._participants.has(agentId)) {
      return { success: false, error: 'Participant already exists: ' + agentId };
    }
    this._participants.set(agentId, {
      agentId,
      metadata: metadata ?? {},
      joinedAt: Date.now(),
      messageCount: 0,
      lastSpokeAt: null,
      active: true,
    });
    this._stats.byParticipant[agentId] = { messages: 0, rounds: 0 };
    this.emit('participant-joined', { agentId });
    return { success: true };
  }

  removeParticipant(agentId) {
    const participant = this._participants.get(agentId);
    if (!participant) return { success: false, error: 'Participant not found' };
    participant.active = false;
    this._participants.delete(agentId);
    this.emit('participant-left', { agentId });
    return { success: true };
  }

  async start(topic) {
    if (this._state === GROUP_CHAT_STATES.ACTIVE) {
      return { success: false, error: 'Group chat already active' };
    }
    if (this._participants.size === 0) {
      return { success: false, error: 'No participants' };
    }
    this._state = GROUP_CHAT_STATES.ACTIVE;
    this._round = 0;
    this._messages.push({
      type: MESSAGE_TYPES.SYSTEM,
      sender: 'system',
      content: 'Group chat started. Topic: ' + (topic ?? 'General discussion'),
      timestamp: Date.now(),
    });
    this.emit('chat-started', { topic });
    return { success: true };
  }

  async speak(agentId, content, type) {
    if (this._state !== GROUP_CHAT_STATES.ACTIVE) {
      return { success: false, error: 'Group chat is not active' };
    }
    const participant = this._participants.get(agentId);
    if (!participant || !participant.active) {
      return { success: false, error: 'Participant not found or inactive: ' + agentId };
    }
    const msgType = type ?? MESSAGE_TYPES.SPEECH;
    const message = {
      type: msgType,
      sender: agentId,
      content,
      round: this._round,
      timestamp: Date.now(),
    };
    this._messages.push(message);
    this._stats.totalMessages++;
    this._stats.byType[msgType] = (this._stats.byType[msgType] ?? 0) + 1;
    if (this._stats.byParticipant[agentId]) {
      this._stats.byParticipant[agentId].messages++;
    }
    participant.messageCount++;
    participant.lastSpokeAt = Date.now();
    this.emit('message-sent', { sender: agentId, content, type: msgType, round: this._round });
    if (this._options.terminationCondition) {
      const shouldTerminate = await safeExecute(() => this._options.terminationCondition(this._messages.toArray(), this._round));
      if (shouldTerminate) {
        return this._completeChat();
      }
    }
    return { success: true, round: this._round };
  }

  async nextSpeaker() {
    const activeParticipants = this._getActiveParticipants();
    if (activeParticipants.length === 0) return null;
    const strategy = this._options.speakerSelection;
    switch (strategy) {
      case SPEAKER_SELECTION.ROUND_ROBIN:
        return this._selectRoundRobin(activeParticipants);
      case SPEAKER_SELECTION.RANDOM:
        return this._selectRandom(activeParticipants);
      case SPEAKER_SELECTION.LLM_CHOICE:
        return this._selectLLMChoice(activeParticipants);
      case SPEAKER_SELECTION.CUSTOM:
        return this._selectCustom(activeParticipants);
      default:
        return activeParticipants[0] ?? null;
    }
  }

  _getActiveParticipants() {
    const active = [];
    for (const [agentId, participant] of this._participants) {
      if (participant.active) active.push(agentId);
    }
    return active;
  }

  _selectRoundRobin(participants) {
    const speaker = participants[this._currentSpeakerIndex % participants.length];
    this._currentSpeakerIndex++;
    return speaker;
  }

  _selectRandom(participants) {
    return participants[Math.floor(Math.random() * participants.length)];
  }

  _selectLLMChoice(participants) {
    return participants[0] ?? null;
  }

  _selectCustom(participants) {
    if (this._options.speakerFn) {
      return this._options.speakerFn(participants, this._messages.toArray(), this._round);
    }
    return participants[0] ?? null;
  }

  advanceRound() {
    this._round++;
    this._stats.totalRounds++;
    if (this._round >= this._options.maxRounds) {
      return this._completeChat();
    }
    this.emit('round-advanced', { round: this._round });
    return { success: true, round: this._round };
  }

  _completeChat() {
    this._state = GROUP_CHAT_STATES.COMPLETED;
    const summary = this._options.summaryFn ? safeExecute(() => this._options.summaryFn(this._messages.toArray())) : null;
    this.emit('chat-completed', { rounds: this._round, messages: this._stats.totalMessages, summary });
    return { success: true, completed: true, rounds: this._round, summary };
  }

  pause() {
    if (this._state !== GROUP_CHAT_STATES.ACTIVE) return { success: false };
    this._state = GROUP_CHAT_STATES.PAUSED;
    this.emit('chat-paused', { round: this._round });
    return { success: true };
  }

  resume() {
    if (this._state !== GROUP_CHAT_STATES.PAUSED) return { success: false };
    this._state = GROUP_CHAT_STATES.ACTIVE;
    this.emit('chat-resumed', { round: this._round });
    return { success: true };
  }

  getHistory() {
    return this._messages.toArray().map(function(m) {
      return Object.assign({}, m);
    });
  }

  getParticipants() {
    const result = [];
    for (const [, participant] of this._participants) {
      result.push({
        agentId: participant.agentId,
        messageCount: participant.messageCount,
        lastSpokeAt: participant.lastSpokeAt,
        active: participant.active,
      });
    }
    return result;
  }

  getStats() {
    return {
      state: this._state,
      round: this._round,
      totalMessages: this._stats.totalMessages,
      totalRounds: this._stats.totalRounds,
      participants: this._participants.size,
      byParticipant: Object.assign({}, this._stats.byParticipant),
      byType: Object.assign({}, this._stats.byType),
    };
  }

  _onShutdown() {
    this._participants.shutdown();
    this._messages.shutdown();
  }
}

module.exports = withShutdown(GroupChat);
module.exports.SPEAKER_SELECTION = SPEAKER_SELECTION;
module.exports.GROUP_CHAT_STATES = GROUP_CHAT_STATES;
module.exports.MESSAGE_TYPES = MESSAGE_TYPES;
