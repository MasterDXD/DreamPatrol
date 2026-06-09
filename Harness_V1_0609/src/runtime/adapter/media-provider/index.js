'use strict';

/**
 * @module runtime/adapter/media-provider
 * 媒体生成提供商统一适配器框架入口。
 * 借鉴OpenClaw 4.5的Provider统一接口设计，支持视频/音乐/图像/演示文稿生成。
 * v2.10.6融合Presenton（PPT生成）和NVIDIA LongLive（视频生成）。
 */

const MediaProviderInterface = require('./media-provider-interface');
const MediaProviderBase = require('./media-provider-base');
const routerModule = require('./media-provider-router');
const PresentationProvider = require('./presentation-provider');
const VideoProvider = require('./video-provider');

module.exports = {
  MediaProviderInterface: MediaProviderInterface,
  MediaProviderBase: MediaProviderBase,
  MediaProviderRouter: routerModule.MediaProviderRouter,
  ROUTING_STRATEGIES: routerModule.ROUTING_STRATEGIES,
  PresentationProvider: PresentationProvider,
  VideoProvider: VideoProvider,
};
