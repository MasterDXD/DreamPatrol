'use strict';

/**
 * @module runtime/infrastructure/ui-action-recorder
 * UI操作录制器，融合自OpenCLI"从浏览器操作生成CLI命令"概念。
 *
 * OpenCLI核心洞察：用户在浏览器中的操作（点击、输入、导航等）
 * 可以被录制并转化为可复用的CLI命令，实现"操作一次，自动重复"。
 *
 * 本模块填补Harness的关键差距：虽然CommandRouter已支持斜杠命令路由，
 * SkillRouter已预置cli-anything语义组，但缺少"UI操作录制→CLI命令生成"的
 * 宏录制能力。本模块实现：
 * - 通过CDP监听用户浏览器操作事件
 * - 将操作序列转化为结构化动作记录
 * - 从动作记录生成可复用的CLI命令或技能定义
 * - 支持录制回放和编辑
 */

const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');
const BoundedArray = require('../../utils/bounded-array');
const EventEmitter = require('events');

/**
 * 录制动作类型
 */
const ACTION_TYPE = {
  NAVIGATE: 'navigate',
  CLICK: 'click',
  TYPE: 'type',
  SCROLL: 'scroll',
  SELECT: 'select',
  SUBMIT: 'submit',
  WAIT: 'wait',
  SCREENSHOT: 'screenshot',
  CUSTOM: 'custom',
};

/**
 * 录制状态
 */
const RECORDER_STATE = {
  IDLE: 'idle',
  RECORDING: 'recording',
  PAUSED: 'paused',
};

const DEFAULT_OPTIONS = {
  maxRecordingLength: 500,
  maxRecordings: 20,
  defaultDelayMs: 500,
  captureScreenshots: false,
};

/**
 * UI操作录制器，融合自OpenCLI的"UI操作→CLI命令生成"概念。
 *
 * 核心原则：
 * - 录制是轻量的：只记录关键操作，不录制每一帧
 * - 生成的命令是可编辑的：用户可修改参数和顺序
 * - 录制可回放：通过BrowserUseAdapter执行录制的操作序列
 * - 录制可转化为技能：将操作序列封装为可复用的技能定义
 *
 * @classdesc UI操作录制器。浏览器操作录制、CLI命令生成、回放执行。
 * @extends EventEmitter
 */
class UIActionRecorder extends EventEmitter {

  /**
   * 创建UIActionRecorder实例。
   * @param {Object} [options] - 配置选项
   * @param {number} [options.maxRecordingLength=500] - 单次录制最大动作数
   * @param {number} [options.maxRecordings=20] - 最大录制保存数
   * @param {number} [options.defaultDelayMs=500] - 动作间默认延迟(毫秒)
   * @param {boolean} [options.captureScreenshots=false] - 是否截图
   */
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._state = RECORDER_STATE.IDLE;
    this._currentRecording = null;
    this._savedRecordings = new Map();
    this._stats = { recordingsStarted: 0, recordingsSaved: 0, actionsRecorded: 0, commandsGenerated: 0 };
  }

  /**
   * 开始录制。
   * @param {string} recordingId - 录制标识
   * @param {Object} [meta] - 录制元数据
   * @param {string} [meta.description=''] - 录制描述
   * @param {string} [meta.url=''] - 起始URL
   * @returns {{ recordingId: string, state: string }} 开始结果
   */
  startRecording(recordingId, meta) {
    this.guardShutdown();
    if (!recordingId) return { recordingId: null, state: this._state };
    if (this._state === RECORDER_STATE.RECORDING) return { recordingId: null, state: this._state };

    this._currentRecording = {
      id: recordingId,
      description: (meta && meta.description) || '',
      startUrl: (meta && meta.url) || '',
      actions: new BoundedArray(this._options.maxRecordingLength),
      startedAt: Date.now(),
      pausedAt: null,
    };
    this._state = RECORDER_STATE.RECORDING;
    this._stats.recordingsStarted++;

    this.emit('recording-started', { recordingId, startUrl: this._currentRecording.startUrl });
    return { recordingId, state: this._state };
  }

  /**
   * 记录一个操作动作，融合自OpenCLI的"浏览器操作录制"概念。
   * @param {string} actionType - 动作类型
   * @param {Object} params - 动作参数
   * @param {string} [params.url] - 导航URL
   * @param {string} [params.selector] - CSS选择器
   * @param {number} [params.x] - 点击X坐标
   * @param {number} [params.y] - 点击Y坐标
   * @param {string} [params.text] - 输入文本
   * @param {string} [params.value] - 选择值
   * @returns {{ recorded: boolean, actionIndex: number }} 记录结果
   */
  recordAction(actionType, params) {
    this.guardShutdown();
    if (this._state !== RECORDER_STATE.RECORDING || !this._currentRecording) {
      return { recorded: false, actionIndex: -1 };
    }

    const action = {
      type: actionType,
      params: params ?? {},
      timestamp: Date.now(),
      delay: this._options.defaultDelayMs,
    };

    this._currentRecording.actions.push(action);
    this._stats.actionsRecorded++;

    this.emit('action-recorded', { recordingId: this._currentRecording.id, actionType, actionIndex: this._currentRecording.actions.length - 1 });

    return { recorded: true, actionIndex: this._currentRecording.actions.length - 1 };
  }

  /**
   * 暂停录制。
   * @returns {{ state: string }} 暂停结果
   */
  pauseRecording() {
    this.guardShutdown();
    if (this._state !== RECORDER_STATE.RECORDING) return { state: this._state };
    this._state = RECORDER_STATE.PAUSED;
    if (this._currentRecording) this._currentRecording.pausedAt = Date.now();
    this.emit('recording-paused', { recordingId: this._currentRecording ? this._currentRecording.id : null });
    return { state: this._state };
  }

  /**
   * 恢复录制。
   * @returns {{ state: string }} 恢复结果
   */
  resumeRecording() {
    this.guardShutdown();
    if (this._state !== RECORDER_STATE.PAUSED) return { state: this._state };
    this._state = RECORDER_STATE.RECORDING;
    if (this._currentRecording) this._currentRecording.pausedAt = null;
    this.emit('recording-resumed', { recordingId: this._currentRecording ? this._currentRecording.id : null });
    return { state: this._state };
  }

  /**
   * 停止录制并保存。
   * @returns {{ recordingId: string, actionCount: number, saved: boolean }} 停止结果
   */
  stopRecording() {
    this.guardShutdown();
    if (this._state === RECORDER_STATE.IDLE) return { recordingId: null, actionCount: 0, saved: false };

    const recording = this._currentRecording;
    if (!recording) {
      this._state = RECORDER_STATE.IDLE;
      return { recordingId: null, actionCount: 0, saved: false };
    }

    recording.completedAt = Date.now();
    recording.actionCount = recording.actions.length;

    // 保存录制
    if (this._savedRecordings.size >= this._options.maxRecordings) {
      const firstKey = this._savedRecordings.keys().next().value;
      if (firstKey !== undefined) this._savedRecordings.delete(firstKey);
    }
    this._savedRecordings.set(recording.id, recording);
    this._stats.recordingsSaved++;

    this._currentRecording = null;
    this._state = RECORDER_STATE.IDLE;

    this.emit('recording-stopped', { recordingId: recording.id, actionCount: recording.actionCount });
    return { recordingId: recording.id, actionCount: recording.actionCount, saved: true };
  }

  /**
   * 从录制生成CLI命令，融合自OpenCLI的"操作→CLI命令生成"概念。
   * @param {string} recordingId - 录制标识
   * @returns {{ recordingId: string, commands: Array<Object>, generated: boolean }} 生成结果
   */
  generateCommands(recordingId) {
    this.guardShutdown();
    const recording = this._savedRecordings.get(recordingId);
    if (!recording) return { recordingId: recordingId || null, commands: [], generated: false };

    const actions = recording.actions.toArray();
    const commands = [];

    for (const action of actions) {
      const cmd = this._actionToCommand(action);
      if (cmd) commands.push(cmd);
    }

    this._stats.commandsGenerated += commands.length;
    this.emit('commands-generated', { recordingId, commandCount: commands.length });

    return { recordingId, commands, generated: commands.length > 0 };
  }

  /**
   * 获取录制详情。
   * @param {string} recordingId - 录制标识
   * @returns {Object|null} 录制详情
   */
  getRecording(recordingId) {
    const recording = this._savedRecordings.get(recordingId);
    if (!recording) return null;
    return {
      id: recording.id,
      description: recording.description,
      startUrl: recording.startUrl,
      actionCount: recording.actionCount || recording.actions.length,
      startedAt: recording.startedAt,
      completedAt: recording.completedAt,
    };
  }

  /**
   * 列出所有保存的录制。
   * @returns {Array<Object>} 录制列表
   */
  listRecordings() {
    const result = [];
    for (const [id, rec] of this._savedRecordings) {
      result.push({
        id,
        description: rec.description,
        startUrl: rec.startUrl,
        actionCount: rec.actionCount || rec.actions.length,
        startedAt: rec.startedAt,
        completedAt: rec.completedAt,
      });
    }
    return result;
  }

  /**
   * 获取统计信息。
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      recordingsStarted: this._stats.recordingsStarted,
      recordingsSaved: this._stats.recordingsSaved,
      actionsRecorded: this._stats.actionsRecorded,
      commandsGenerated: this._stats.commandsGenerated,
      savedRecordings: this._savedRecordings.size,
      currentState: this._state,
    };
  }

  /**
   * 将动作转换为CLI命令。
   * @param {Object} action - 动作记录
   * @returns {Object|null} CLI命令
   * @private
   */
  _actionToCommand(action) {
    if (!action || !action.type) return null;

    switch (action.type) {
      case ACTION_TYPE.NAVIGATE:
        return { command: 'navigate', args: { url: action.params.url || '' }, description: 'Navigate to ' + (action.params.url || '(unknown)') };
      case ACTION_TYPE.CLICK:
        return { command: 'click', args: { selector: action.params.selector, x: action.params.x, y: action.params.y }, description: 'Click ' + (action.params.selector || 'at (' + action.params.x + ',' + action.params.y + ')') };
      case ACTION_TYPE.TYPE:
        return { command: 'type', args: { selector: action.params.selector, text: action.params.text }, description: 'Type into ' + (action.params.selector || '(unknown)') };
      case ACTION_TYPE.SELECT:
        return { command: 'select', args: { selector: action.params.selector, value: action.params.value }, description: 'Select ' + (action.params.value || '') + ' in ' + (action.params.selector || '(unknown)') };
      case ACTION_TYPE.SUBMIT:
        return { command: 'submit', args: { selector: action.params.selector }, description: 'Submit form ' + (action.params.selector || '(unknown)') };
      case ACTION_TYPE.WAIT:
        return { command: 'wait', args: { ms: action.params.ms || action.delay }, description: 'Wait ' + (action.params.ms || action.delay) + 'ms' };
      case ACTION_TYPE.SCROLL:
        return { command: 'scroll', args: { x: action.params.x, y: action.params.y }, description: 'Scroll to (' + action.params.x + ',' + action.params.y + ')' };
      default:
        return { command: action.type, args: action.params, description: action.type + ' action' };
    }
  }

  _onShutdown() {
    this._currentRecording = null;
    this._savedRecordings.clear();
    this._state = RECORDER_STATE.IDLE;
    this.removeAllListeners();
  }
}

UIActionRecorder.ACTION_TYPE = ACTION_TYPE;
UIActionRecorder.RECORDER_STATE = RECORDER_STATE;

module.exports = withShutdown(UIActionRecorder);
