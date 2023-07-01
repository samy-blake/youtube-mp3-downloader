"use strict";
const os = require("os");
const EventEmitter = require("events").EventEmitter;
const ffmpeg = require("fluent-ffmpeg");
const ytdl = require("ytdl-core");
const async = require("async");
const progress = require("progress-stream");
const sanitize = require("sanitize-filename");
const fs = require("fs");

function getProgressData(percentage) {
  return {
    percentage: percentage,
    transferred: 0,
    length: 0,
    remaining: 0,
    eta: 0,
    runtime: 0,
    delta: 0,
    speed: 0,
  };
}

class YoutubeMp3Downloader extends EventEmitter {
  constructor(options) {
    super();
    this.youtubeBaseUrl = "http://www.youtube.com/watch?v=";
    this.youtubeVideoQuality =
      options && options.youtubeVideoQuality
        ? options.youtubeVideoQuality
        : "highestaudio";
    this.outputPath =
      options && options.outputPath ? options.outputPath : os.homedir();
    this.queueParallelism =
      options && options.queueParallelism ? options.queueParallelism : 1;
    this.progressTimeout =
      options && options.progressTimeout ? options.progressTimeout : 1000;
    this.requestOptions =
      options && options.requestOptions
        ? options.requestOptions
        : { maxRedirects: 5 };
    this.outputOptions =
      options && options.outputOptions ? options.outputOptions : [];
    this.allowWebm = options && options.allowWebm ? options.allowWebm : false;

    if (options && options.ffmpegPath) {
      ffmpeg.setFfmpegPath(options.ffmpegPath);
    }

    this.setupQueue();
  }

  setupQueue() {
    let self = this;
    // Async download/transcode queue
    this.downloadQueue = async.queue(function (task, callback) {
      self.emit(
        "queueSize",
        self.downloadQueue.running() + self.downloadQueue.length()
      );

      self.performDownload(task, function (err, result) {
        callback(err, result);
      });
    }, self.queueParallelism);
  }

  download(videoId, options = {}) {
    let self = this;
    const task = {
      videoId: videoId,
      fileName: undefined,
      options,
    };

    this.downloadQueue.push(task, function (err, data) {
      self.emit(
        "queueSize",
        self.downloadQueue.running() + self.downloadQueue.length()
      );

      if (err) {
        self.emit("error", err, data);
      } else {
        self.emit("finished", err, data);
      }
    });
  }

  async getVideoDetails(videoId) {
    const videoUrl = this.youtubeBaseUrl + videoId;
    try {
      const info = await ytdl.getInfo(videoUrl, {
        quality: this.youtubeVideoQuality,
      });
      return info?.player_response?.videoDetails;
    } catch (err) {
      console.error(err);
    }
  }

  async performDownload(task, callback) {
    let self = this;
    let info;
    const videoUrl = this.youtubeBaseUrl + task.videoId;
    let resultObj = {
      videoId: task.videoId,
    };

    try {
      info = await ytdl.getInfo(videoUrl, {
        quality: this.youtubeVideoQuality,
      });
    } catch (err) {
      return callback(err);
    }
    let forLongVideos = false;

    try {
      const videoLength = Number.parseInt(info.videoDetails.lengthSeconds);

      if (videoLength / 60 > 20) {
        forLongVideos = true;
      }
    } catch (err) {
      return callback(err);
    }

    let videoTitle = sanitize(info.videoDetails.title);
    let artist = "Unknown";
    let title = "Unknown";
    const thumbnail = info.videoDetails.thumbnails
      ? info.videoDetails.thumbnails[0].url
      : info.videoDetails.thumbnail || null;

    if (videoTitle.indexOf("-") > -1) {
      let temp = videoTitle.split("-");
      if (temp.length >= 2) {
        artist = temp[0].trim();
        title = temp[1].trim();
      }
    } else {
      title = videoTitle;
    }
    videoTitle = videoTitle.split(" ").join("_");

    // Derive file name, if given, use it, if not, from video title
    const downloadMp3FileName =
      (task.fileName ? sanitize(task.fileName) : videoTitle || info.videoId) +
      ".mp3";
    const downloadVideoFileName =
      (task.fileName ? sanitize(task.fileName) : videoTitle || info.videoId) +
      ".mp4";
    const mp3fileName = self.outputPath + "/" + downloadMp3FileName;
    const videofileName = self.outputPath + "/" + downloadVideoFileName;

    // if (fs.existsSync(mp3fileName)) {
    //   return;
    // }

    // Stream setup
    const streamOptions = {
      quality: self.youtubeVideoQuality,
      requestOptions: self.requestOptions,
    };

    if (!self.allowWebm) {
      streamOptions.filter = (format) => format.container === "mp4";
    }

    let audioBitrateList = info.formats.filter(
      (format) => !!format.audioBitrate
    );
    audioBitrateList.sort((a, b) => b.audioBitrate - a.audioBitrate);
    const audioBitrate = audioBitrateList[0].audioBitrate;
    let outputOptions = [
      "-id3v2_version",
      "4",
      "-metadata",
      "title=" + title,
      "-metadata",
      "artist=" + artist,
    ];
    if (self.outputOptions) {
      outputOptions = outputOptions.concat(self.outputOptions);
    }
    if (task.options && task.options.quality) {
      streamOptions.quality = task.options.quality;
      switch (streamOptions.quality) {
        case "highestaudio":
        case "lowestaudio":
          streamOptions.filter = "audio";
          break;
        case "highestvideo":
        case "lowestvideo":
          streamOptions.filter = "video";
          break;
        case "highest":
        case "lowest":
          streamOptions.filter = "audioandvideo";
          break;

        default:
          break;
      }
    }

    if (forLongVideos || streamOptions.quality !== self.youtubeVideoQuality) {
      const videoReadStream = fs.createWriteStream(videofileName);
      self.emit("progress", {
        videoId: task.videoId,
        progress: getProgressData(0),
        fileName: downloadMp3FileName,
        meta: info,
      });

      videoReadStream
        .on("error", function (err) {
          self.emit("delete", {
            videoId: task.videoId,
            progress: 0,
            fileName: downloadMp3FileName,
            videoFileName: videofileName,
            meta: info,
          });
          return callback(err.message, {
            fileName: downloadMp3FileName,
          });
        })
        .on("finish", () => {
          if (!fs.existsSync(videofileName)) {
            return callback("download file not found", {
              fileName: downloadMp3FileName,
            });
          }

          if (streamOptions.quality !== self.youtubeVideoQuality) {
            self.emit("progress", {
              videoId: task.videoId,
              progress: getProgressData(100),
              fileName: downloadVideoFileName,
              meta: info,
            });

            resultObj.file = videofileName;
            resultObj.youtubeUrl = videoUrl;
            resultObj.videoTitle = videoTitle;
            resultObj.artist = artist;
            resultObj.title = title;
            resultObj.thumbnail = thumbnail;
            resultObj.fileName = downloadVideoFileName;
            return callback(null, resultObj);
          } else {
            self.emit("progress", {
              videoId: task.videoId,
              progress: getProgressData(50),
              fileName: downloadMp3FileName,
              meta: info,
            });
            // Start encoding
            // ffmpeg(fs.createReadStream(videofileName))
            ffmpeg(videofileName)
              .audioBitrate(audioBitrate || 192)
              .withAudioCodec("libmp3lame")
              .toFormat("mp3")
              .outputOptions(...outputOptions)
              .on("error", function (err) {
                fs.unlink(videofileName, function (err, data) {
                  if (err) {
                    return callback(err.message, {
                      fileName: downloadMp3FileName,
                    });
                  } else {
                    self.emit("delete", {
                      videoId: task.videoId,
                      progress: 0,
                      fileName: downloadMp3FileName,
                      videoFileName: videofileName,
                      meta: info,
                    });
                  }
                });
                return callback(err.message, {
                  fileName: downloadMp3FileName,
                });
              })
              .on("end", function () {
                self.emit("progress", {
                  videoId: task.videoId,
                  progress: getProgressData(100),
                  fileName: downloadMp3FileName,
                  meta: info,
                });

                fs.unlink(videofileName, function (err, data) {
                  if (err) {
                    return callback(err.message, {
                      fileName: downloadMp3FileName,
                    });
                  } else {
                    self.emit("delete", {
                      videoId: task.videoId,
                      progress: 0,
                      fileName: downloadMp3FileName,
                      videoFileName: videofileName,
                      meta: info,
                    });
                  }
                });

                resultObj.file = mp3fileName;
                resultObj.youtubeUrl = videoUrl;
                resultObj.videoTitle = videoTitle;
                resultObj.artist = artist;
                resultObj.title = title;
                resultObj.thumbnail = thumbnail;
                resultObj.fileName = downloadMp3FileName;
                return callback(null, resultObj);
              })
              .saveToFile(mp3fileName);
          }
        });
      ytdl(videoUrl, streamOptions).pipe(videoReadStream);
    } else {
      const stream = ytdl.downloadFromInfo(info, streamOptions);
      stream.on("error", function (err) {
        callback(err, null);
      });

      stream.on("response", function (httpResponse) {
        // Setup of progress module
        const str = progress({
          length: parseInt(httpResponse.headers["content-length"]),
          time: self.progressTimeout,
        });

        // Add progress event listener
        str.on("progress", function (progress) {
          if (progress.percentage === 100) {
            resultObj.stats = {
              transferredBytes: progress.transferred,
              runtime: progress.runtime,
              averageSpeed: parseFloat(progress.speed.toFixed(2)),
            };
          }
          self.emit("progress", {
            videoId: task.videoId,
            progress: progress,
            fileName: downloadMp3FileName,
            meta: info,
          });
        });

        // Start encoding
        ffmpeg(stream.pipe(str))
          .audioBitrate(audioBitrate || 192)
          .withAudioCodec("libmp3lame")
          .toFormat("mp3")
          .outputOptions(...outputOptions)
          .on("error", function (err) {
            self.emit("delete", {
              videoId: task.videoId,
              progress: 0,
              fileName: downloadMp3FileName,
              meta: info,
            });
            return callback(err.message, {
              fileName: downloadMp3FileName,
            });
          })
          .on("end", function () {
            resultObj.file = mp3fileName;
            resultObj.youtubeUrl = videoUrl;
            resultObj.videoTitle = videoTitle;
            resultObj.artist = artist;
            resultObj.title = title;
            resultObj.thumbnail = thumbnail;
            resultObj.fileName = downloadMp3FileName;
            return callback(null, resultObj);
          })
          .saveToFile(mp3fileName);
      });
    }
  }
}

module.exports = YoutubeMp3Downloader;
