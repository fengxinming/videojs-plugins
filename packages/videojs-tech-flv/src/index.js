import flvjs from 'flv.js';

const { METADATA_ARRIVED, MEDIA_INFO, ERROR } = flvjs.Events;
const { NETWORK_ERROR, MEDIA_ERROR } = flvjs.ErrorTypes;
const defaults = {
  mediaDataSource: {
    type: 'flv'
  }
};
const LOG_FLAG = '[videojs-tech-flv] >';

function isLive(duration) {
  return isNaN(duration) || duration === Infinity;
}

const { userAgent } = navigator;
const isSafari = /Safari/.test(userAgent) && !/Chrome/.test(userAgent);

export default function (videojs) {
  const flv = videojs.getTech('flv');
  if (flv) {
    return flv;
  }

  const Html5 = videojs.getTech('Html5');
  const mergeOptions = videojs.mergeOptions;

  /**
   * 参考 videojs-flash
   */
  class Flv extends Html5 {
  /**
   * 创建 Tech 实例
   * @param {object} options flv.js播放参数
   */
    constructor(options, ready) {
      super(mergeOptions(defaults, options), ready);
      this.featuresPlaybackRate = true;

      this.resetInnerProps();

      const player = this.getPlayer();

      const removeWaiting = () => {
        setTimeout(() => {
          try {
            player.removeClass('vjs-waiting');
          }
          catch (e) {}
        }, 400);
      };

      this.on('loadeddata', () => {
        console.log(LOG_FLAG, '已获取到视频数据');
        this.reconnTimes_ = 0;
      });
      this.on('play', (e) => {
        removeWaiting();
      });
      this.on('playing', (e) => {
        removeWaiting();
      });
      // 重新拉流后，播放器里面的 playbackRate 被重置
      this.on('canplay', () => {
        const { playbackRate_ } = this;
        if (this.el_.playbackRate !== playbackRate_) {
          super.setPlaybackRate(playbackRate_);
        }
      });

      if (isSafari) {
        const tryPlaying = (videoEl, timeout) => {
          setTimeout(() => {
            if (videoEl.readyState > 2 && videoEl.paused) {
              player.removeClass('vjs-paused');
              silencePromise(this.flvPlayer.play(), 'this.flvPlayer.play():');
            }
            else {
              tryPlaying(videoEl, timeout);
            }
          }, timeout);
        };

        // 解决 Safari 不显示live标识
        this.duration = () => {
          return this.duration_ || Infinity;
        };
        // 解决 Safari 直播暂停问题
        this.on('ended', () => {
          if (isLive(this.duration())) {
            player.removeClass('vjs-paused');
            player.addClass('vjs-waiting');
          }
        });
        this.on('pause', (e) => {
        // console.log('pause');
          if (isLive(this.duration()) && this.autoplay() && this.ended()) {
            player.removeClass('vjs-paused');
            tryPlaying(e.target, 1000);
          }
        });
        this.on('waiting', (e) => {
          player.removeClass('vjs-paused');
          silencePromise(this.pause(), 'this.pause()').then(() => {
            player.removeClass('vjs-paused');
          });
          setTimeout(() => {
            silencePromise(this.play(), 'this.play():');
          }, 1000);
        });
        this.on('canplay', (e) => {
        // console.log('canplay');
          player.removeClass('vjs-paused');
          if (this.autoplay() && this.paused()) {
            player.removeClass('vjs-paused');
            tryPlaying(e.target, 1000);
          }
        });
      }
      else {
        this.on('canplay', () => {
          removeWaiting();
          if (this.needPlay_ && this.paused()) {
            silencePromise(this.play(), 'this.play():').then(() => {
              this.needPlay_ = false;
            });
          }
        });
      }

      this.seekDebounced = debounce(() => {
        player.userActive(false);
        this.destroyFlv();
        this.needPlay_ = true;
        this.seek(this.lastSeekTarget_, true);
      }, 0);

      const playbackRateMenuButton  = this.getPlaybackRateMenuButton();
      if (playbackRateMenuButton) {
        this.on('durationchange', () => {
          playbackRateMenuButton[isLive(this.duration()) ? 'hide' : 'show']();
        });
      }
    }

    /**
     * 播放视频
     */
    play() {
      const { options_, flvPlayer } = this;
      if (!options_.mediaDataSource.url) {
        console.warn('未设置播放源');
        return Promise.resolve();
      }

      if (!flvPlayer) {
        this.needPlay_ = true;
        this.load();
        return Promise.resolve();
      }
      else if (this.ended()) { // 上次已经播完
        return Promise.resolve(this.options_.getStreamUrl()).then((newUrl) => {
          this.needPlay_ = true;
          const player = this.getPlayer();
          player.addClass('vjs-waiting');
          this.load(newUrl);
        });
      }
      else if (this.paused()) { // 暂停状态下播放
        if (!this.duration_) {
        // 播放最新的缓存
          const seekable = this.seekable();
          super.setCurrentTime((seekable.end(seekable.length - 1) * 10 >>> 0) / 10);
        }
        return flvPlayer.play();
      }
      return Promise.resolve();
    }

    /**
     * 暂停播放视频
     */
    pause() {
      const { flvPlayer } = this;
      if (flvPlayer) {
        return flvPlayer.pause();
      }
      return Promise.resolve();
    }

    /**
     * 提供当前时间秒
     */
    currentTime() {
      if (this.seeking_) {
        return this.lastSeekTarget_;
      }
      return this.lastSeekTarget_ + super.currentTime();
    }

    /**
     * 播放总时长
     */
    duration() {
      return this.lastSeekTarget_ // 拖动进度条的情况
        ? (this.duration_ || super.duration()) // 改变 offset 之后的流没有返回 duration，所以要用之前的
        : super.duration();
    }

    /**
   * 是否手动拖动进度条
   * @param {boolean} scrubbing
   */
    setScrubbing(scrubbing) {
      this.scrubbing_ = scrubbing;

      // 拖动进度条结束
      if (!scrubbing) {
        this.seeking_ = false;
        this.getPlayer().addClass('vjs-waiting');
        this.seekDebounced();
      }
    }

    /**
   * 修改当前时间触发，包括拉动进度条
   * @param {Number} seconds 秒
   */
    setCurrentTime(seconds) {
      const seekable = this.seekable();
      if (seekable.length) {
        const start = seekable.start(0);
        const end = seekable.end(seekable.length - 1);

        seconds = seconds > start ? seconds : start;
        seconds = seconds < end ? seconds : end;
        this.lastSeekTarget_ = seconds >>> 0;
        this.seeking_ = true;
        // this.trigger('seeking');

        // 代码设置 currentTime
        if (!this.scrubbing_) {
          this.setScrubbing(false);
        }

        this.getPlayer().trigger({
          type: 'timeupdate',
          target: this,
          manuallyTriggered: true
        });
      }
    }

    /**
     * 加载flvPlayer
     * @param {string} src 是否设置新的url
     */
    load(src) {
      const player = this.getPlayer();
      if (!src) {
        src = player.src();
        this.resetInnerProps();
      }
      if (!src) {
        return;
      }
      player.addClass('vjs-waiting');
      this.initInnerProps();
      this.destroyFlv();

      const { mediaDataSource, flvConfig } = this.options_;

      mediaDataSource.url = src;
      flvConfig.playerId = player.id_;
      let flvPlayer = null;
      try {
        flvPlayer = flvjs.createPlayer(mediaDataSource, flvConfig);
      }
      catch (e) {
        return flvPlayer;
      }
      flvPlayer.on(METADATA_ARRIVED, (info) => {
        console.log(LOG_FLAG, 'METADATA: ', info);
        this.duration_ = info.duration;
      });
      flvPlayer.on(MEDIA_INFO, (info) => {
        console.log(LOG_FLAG, 'MEDIA: ', info);
      });
      // 异常情况
      flvPlayer.on(ERROR, (...args) => {
        const currentTime = this.currentTime();
        const duration = this.duration();
        console.log(LOG_FLAG, `currentTime: ${currentTime}`, `duration: ${duration}`);

        const { /* lastSeekTarget_, */options_ } = this;
        const { reconnTimes, reconnInterval, getStreamUrl } = options_;
        switch (args[0]) {
          case NETWORK_ERROR:
          case MEDIA_ERROR: {
          // 直播重试
            if (isLive(duration) && this.reconnTimes_ < reconnTimes) {
              console.error(LOG_FLAG, 'error: ', args);
              player.addClass('vjs-waiting');
              setTimeout(() => {
                console.log(LOG_FLAG, `尝试第 ${++this.reconnTimes_} 重新拉流`);
                Promise.resolve(getStreamUrl()).then((newUrl) => {
                // this.load(lastSeekTarget_ ? changeOffset(newUrl, lastSeekTarget_ * 1000) : newUrl);
                  this.load(newUrl);
                });
              }, reconnInterval);
              return;
            }
          }
        }

        player.trigger({
          type: 'flvError',
          errorInfo: args,
          lastSeekTarget: this.lastSeekTarget_
        });
      });
      flvPlayer.attachMediaElement(this.el_);
      flvPlayer.load();

      this.flvPlayer = flvPlayer;
      return flvPlayer;
    }

    /**
   * 设置偏移量
   * @param {number} seconds
   * @param {boolean} reload
   */
    seek(seconds, reload) {
      const { options_ } = this;
      // const url = options_.mediaDataSource.url.replace(/[?&]offset=[0-9.]+/, '');
      if (reload) {
      // 竟然出现null的情况
        options_ && Promise.resolve(options_.getStreamUrl()).then((newUrl) => {
          const playbackRate = this.playbackRate_;
          this.load(changeQueries(newUrl, {
            speed: playbackRate,
            keyIndex: playbackRate < 4 ? 0 : 1,
            offset: seconds * 1000
          }));
        });
      }
    }

    /**
     * 重置video实例，player.reset将触发该方法
     */
    reset() {
      const player = this.getPlayer();
      player.removeClass('vjs-has-started');
      // player.removeClass('vjs-user-inactive');
      this.resetInnerProps();
      super.setPlaybackRate(1);
      this.destroyFlv();
    }

    /**
     * 销毁播放器
     */
    dispose() {
      this.reset();
      super.dispose();
    }

    /**
   * 销毁 flvPlayer 实例
   */
    destroyFlv() {
      const { flvPlayer, options_ } = this;
      if (flvPlayer) {
        flvPlayer.unload();
        flvPlayer.detachMediaElement();
        flvPlayer.destroy();
        flvPlayer._seekpointRecord = null;
        if (options_) {
          delete options_.mediaDataSource.segments;
        }
        this.flvPlayer = null;
      }
      super.reset();
    }

    /**
     * 初始化内部属性
     */
    initInnerProps() {
      this.seeking_ = false;
      this.duration_ = undefined;
      this.scrubbing_ = false;
    }

    /**
     * 重置内部属性
     */
    resetInnerProps() {
      this.initInnerProps();
      this.reconnTimes_ = 0;
      this.needPlay_ = false;
      this.lastSeekTarget_ = 0;
      this.playbackRate_ = 1;
    }

    /**
     * 获取当前播放器
     */
    getPlayer() {
      return videojs.getPlayer(this.options_.playerId);
    }

    /**
     * 获取控制条
     */
    getControlBar() {
      let { controlBar_ } = this;
      if (controlBar_) {
        return controlBar_;
      }
      controlBar_ = this.getPlayer().controlBar || null;
      this.controlBar_ = controlBar_;
      return controlBar_;
    }

    /**
     * 获取倍数播放按钮
     */
    getPlaybackRateMenuButton() {
      let { playbackRateMenuButton_ } = this;
      if (playbackRateMenuButton_) {
        return playbackRateMenuButton_;
      }
      const controlBar = this.getControlBar();
      if (controlBar) {
        playbackRateMenuButton_ = controlBar.playbackRateMenuButton;
        this.playbackRateMenuButton_ = playbackRateMenuButton_;
      }
      return playbackRateMenuButton_ || null;
    }

    /**
   * 播放器将获取source标签中的src并传入该方法
   * @param {string} src 兼容string
   */
    setSrc(src) {
      const { mediaDataSource } = this.options_;
      mediaDataSource.url = src;
    }

    /**
   * 是否正在拖动
   */
    seeking() {
      return this.seeking_;
    }

    /**
     * 设置倍数播放
     */
    setPlaybackRate(v) {
      if (v === this.playbackRate_) {
        return;
      }

      this.trigger('ratechange');
      const player = this.getPlayer();
      player.userActive(false);
      player.addClass('vjs-waiting');

      const { options_ } = this;
      // 竟然出现null的情况
      if (options_) {
        Promise.resolve(options_.getStreamUrl()).then((newUrl) => {
          this.load(changeQueries(newUrl, {
            speed: v,
            keyIndex: v < 4 ? 0 : 1,
            offset: this.lastSeekTarget_ * 1000
          }));
          this.playbackRate_ = v;
        });
      }
    }

    /**
     * 返回播放倍数
     */
    playbackRate() {
      return this.playbackRate_;
    }
  }

  /**
 * 检查是否支持 flvjs 播放
 * @return {boolean}
 */
  Flv.isSupported = function () {
    return flvjs && flvjs.isSupported();
  };

  /**
 * 给定支持的flv格式
 *
 * @constant {object}
 */
  Flv.formats = {
    'video/iotx-flv': 'FLV',
    'video/flv': 'FLV',
    'video/x-flv': 'FLV'
  };

  /**
 * 检查支持的播放格式
 *
 * @param {string} type
 * @returns {string} 'maybe', or ''
 */
  Flv.canPlayType = function (type) {
    if (Flv.isSupported() && type in Flv.formats) {
      return 'maybe';
    }

    return '';
  };

  /**
 * 检查支持的播放格式
 *
 * @param {Object} source
 * @param {Object} options
 * @return {string} 'maybe', or ''
 */
  Flv.canPlaySource = function (source/* , options */) {
    return Flv.canPlayType(source.type);
  };

  Flv.debounce = debounce;
  Flv.silencePromise = silencePromise;
  Flv.changeOffset = changeOffset;
  Flv.VERSION = '__VERSION__';

  videojs.registerTech('flv', Flv);

  return Flv;
}

