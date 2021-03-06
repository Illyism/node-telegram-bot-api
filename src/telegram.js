var EventEmitter = require('events').EventEmitter;
var Promise = require("bluebird");
var request = require("request");
var stream = require('stream');
var https = require('https');
var http = require('http');
var util = require('util');
var mime = require('mime');
var path = require('path');
var URL = require('url');
var fs = require('fs');

var requestPromise = Promise.promisify(request);

/**
 * Both request method to obtain messages are implemented. To use standard polling, set `polling: true`
 * on `options`. Notice that [webHook](https://core.telegram.org/bots/api#setwebhook) will need a valid (not self signed) SSL certificate.
 * Emmits `message` when a message arrives.
 *
 * @class TelegramBot
 * @constructor
 * @param {String} token Bot Token
 * @param {Object} [options]
 * @param {Boolean|Object} [options.polling=false] Set true to enable polling
 * @param {String|Number} [options.polling.timeout=4] Polling time
 * @param {Boolean|Object} [options.webHook=false] Set true to enable WebHook
 * @param {String} [options.webHook.key] PEM private key to webHook server
 * @param {String} [options.webHook.cert] PEM certificate key to webHook server
 * @see https://core.telegram.org/bots/api
 */
var TelegramBot = function (token, options) {
  options = options || {};
  this.token = token;
  this.offset = 0;
  this._webServer = null;

  if (options.polling) {
    // By default polling for 4 seconds
    var timeout = options.polling.timeout || 4;
    this._polling(timeout);
  }

  if (options.webHook) {
    var port = options.webHook.port || 8443;
    var key = options.webHook.key;
    var cert = options.webHook.cert;
    var host = options.webHook.host;
    this._configureWebHook(port, host, key, cert);
  }
};

util.inherits(TelegramBot, EventEmitter);

TelegramBot.prototype._configureWebHook = function (port, host, key, cert) {
  var protocol = 'HTTP';
  var self = this;

  if (key && cert) { // HTTPS Server
    protocol = 'HTTPS';
    var options = {
      key: fs.readFileSync(key),
      cert: fs.readFileSync(cert)
    };
    this._webServer = https.createServer(options, function (req, res) {
       self._requestListener.call(self, req, res);
    });
  } else { // HTTP Server
    this._webServer = http.createServer(function (req, res) {
      self._requestListener.call(self, req, res);
    });
  }

  this._webServer.listen(port, host, function () {
    console.log(protocol+" WebHook listening on:", port);
  });
};

TelegramBot.prototype._requestListener = function (req, res) {
  var self = this;
  var url = '/bot'+this.token;
  if (req.url === url && req.method === 'POST') {
    var fullBody = '';
    req.on('data', function (chunk) {
      fullBody += chunk.toString();
    });
    req.on('end', function () {
      try {
        var data = JSON.parse(fullBody);
        self.offset = data.update_id;
        self.emit('message', data.message);
      } catch (error) {
        console.error(error);
      }
      res.end('OK :P\n');
    });
  } else {
    res.end('OK\n');
  }
};

TelegramBot.prototype._processUpdates = function (updates) {
  for (var i = 0; i < updates.length; i++) {
    if (updates[i].message) {
      this.emit('message', updates[i].message);
    }
  }
};

TelegramBot.prototype._polling = function (timeout) {
  var self = this;
  this.getUpdates(timeout).then(function (data) {
    self._processUpdates(data);
    self._polling(timeout);
  });
};

TelegramBot.prototype._request = function (path, options) {
  if (!this.token) {
    throw new Error('Telegram Bot Token not provided!');
  }
  options = options || {};
  options.url = URL.format({
    protocol: 'https',
    host: 'api.telegram.org',
    pathname: '/bot'+this.token+'/'+path
  });

  return requestPromise(options)
    .then(function (resp) {
      if (resp[0].statusCode !== 200) {
        throw new Error(resp[0].statusCode+' '+resp[0].body);
      }
      var data = JSON.parse(resp[0].body);
      if (data.ok) {
        return data.result;
      } else {
        throw new Error(data.error_code+' '+data.description);
      }
    });
};

/**
 * Returns basic information about the bot in form of a `User` object.
 * @return {Promise}
 * @see
 */
TelegramBot.prototype.getMe = function () {
  var path = 'getMe';
  return this._request(path);
};

/**
 * Specify an url to receive incoming updates via an outgoing webHook.
 * @param {String} url URL where Telegram will make HTTP Post. Leave empty to
 * delete webHook.
 * @see https://core.telegram.org/bots/api#setwebhook
 */
TelegramBot.prototype.setWebHook = function (url) {
  var path = 'setWebHook';
  var qs = {url: url};
  return this._request(path, {qs: qs})
    .then(function (resp) {
      if (!resp) {
        throw new Error(resp);
      }
      return resp;
    });
};

/**
 * Use this method to receive incoming updates using long polling
 * @param  {Number|String} [timeout] Timeout in seconds for long polling.
 * @param  {Number|String} [limit] Limits the number of updates to be retrieved.
 * @param  {Number|String} [offset] Identifier of the first update to be returned.
 * @return {Promise} Updates
 * @see https://core.telegram.org/bots/api#getupdates
 */
TelegramBot.prototype.getUpdates = function (timeout, limit, offset) {
  var self = this;
  var query = {
    offset: offset || this.offset+1,
    limit: limit,
    timeout: timeout
  };

  return this._request('getUpdates', {qs: query})
    .then(function (result) {
      var last = result[result.length-1];
      if (last) {
        self.offset = last.update_id;
      }
      return result;
    });
};

/**
 * Send text message.
 * @param  {Number|String} chatId Unique identifier for the message recipient
 * @param  {Sting} text Text of the message to be sent
 * @param  {Object} [options] Additional Telegram query options
 * @return {Promise}
 * @see https://core.telegram.org/bots/api#sendmessage
 */
TelegramBot.prototype.sendMessage = function (chatId, text, options) {
  var query = options || {};
  query.chat_id = chatId;
  query.text = text;
  return this._request('sendMessage', {qs: query});
};

/**
 * Forward messages of any kind.
 * @param  {Number|String} chatId     Unique identifier for the message recipient
 * @param  {Number|String} fromChatId Unique identifier for the chat where the
 * original message was sent
 * @param  {Number|String} messageId  Unique message identifier
 * @return {Promise}
 */
TelegramBot.prototype.forwardMessage = function (chatId, fromChatId, messageId) {
  var query = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId
  };
  return this._request('forwardMessage', {qs: query});
};

TelegramBot.prototype._formatSendData = function (type, data) {
  var formData;
  var fileName;
  var fileId;
  if (data instanceof stream.Stream) {
    fileName = path.basename(data.path);
    formData = {};
    formData[type] = {
      value: data,
      options: {
        filename: fileName,
        contentType: mime.lookup(fileName)
      }
    };
  } else if (fs.existsSync(data)) {
    fileName = path.basename(data);
    formData = {};
    formData[type] = {
      value: fs.createReadStream(data),
      options: {
        filename: fileName,
        contentType: mime.lookup(fileName)
      }
    };
  } else {
    fileId = data;
  }
  return [formData, fileId];
};

/**
 * Send photo
 * @param  {Number|String} chatId  Unique identifier for the message recipient
 * @param  {String|stream.Stream} photo A file path or a Stream. Can
 * also be a `file_id` previously uploaded
 * @param  {Object} [options] Additional Telegram query options
 * @return {Promise}
 * @see https://core.telegram.org/bots/api#sendphoto
 */
TelegramBot.prototype.sendPhoto = function (chatId, photo, options) {
  var opts = {
    qs: options || {}
  };
  opts.qs.chat_id = chatId;
  var content = this._formatSendData('photo', photo);
  opts.formData = content[0];
  opts.qs.photo = content[1];
  return this._request('sendPhoto', opts);
};

/**
 * Send audio
 * @param  {Number|String} chatId  Unique identifier for the message recipient
 * @param  {String|stream.Stream} audio A file path or a Stream. Can
 * also be a `file_id` previously uploaded.
 * @param  {Object} [options] Additional Telegram query options
 * @return {Promise}
 * @see https://core.telegram.org/bots/api#sendaudio
 */
TelegramBot.prototype.sendAudio = function (chatId, audio, options) {
  var opts = {
    qs: options || {}
  };
  opts.qs.chat_id = chatId;
  var content = this._formatSendData('audio', audio);
  opts.formData = content[0];
  opts.qs.audio = content[1];
  return this._request('sendAudio', opts);
};

/**
 * Send Document
 * @param  {Number|String} chatId  Unique identifier for the message recipient
 * @param  {String|stream.Stream} A file path or a Stream. Can
 * also be a `file_id` previously uploaded.
 * @param  {Object} [options] Additional Telegram query options
 * @return {Promise}
 * @see https://core.telegram.org/bots/api#sendDocument
 */
TelegramBot.prototype.sendDocument = function (chatId, doc, options) {
  var opts = {
    qs: options || {}
  };
  opts.qs.chat_id = chatId;
  var content = this._formatSendData('document', doc);
  opts.formData = content[0];
  opts.qs.document = content[1];
  return this._request('sendDocument', opts);
};

/**
 * Send .webp stickers.
 * @param  {Number|String} chatId  Unique identifier for the message recipient
 * @param  {String|stream.Stream} A file path or a Stream. Can
 * also be a `file_id` previously uploaded.
 * @param  {Object} [options] Additional Telegram query options
 * @return {Promise}
 * @see https://core.telegram.org/bots/api#sendsticker
 */
TelegramBot.prototype.sendSticker = function (chatId, sticker, options) {
  var opts = {
    qs: options || {}
  };
  opts.qs.chat_id = chatId;
  var content = this._formatSendData('sticker', sticker);
  opts.formData = content[0];
  opts.qs.sticker = content[1];
  return this._request('sendSticker', opts);
};

/**
 * Send video files, Telegram clients support mp4 videos (other formats may be sent whith `sendDocument`)
 * @param  {Number|String} chatId  Unique identifier for the message recipient
 * @param  {String|stream.Stream} A file path or a Stream. Can
 * also be a `file_id` previously uploaded.
 * @param  {Object} [options] Additional Telegram query options
 * @return {Promise}
 * @see https://core.telegram.org/bots/api#sendvideo
 */
TelegramBot.prototype.sendVideo = function (chatId, video, options) {
  var opts = {
    qs: options || {}
  };
  opts.qs.chat_id = chatId;
  var content = this._formatSendData('video', video);
  opts.formData = content[0];
  opts.qs.video = content[1];
  return this._request('sendVideo', opts);
};


/**
 * Send chat action.
 * `typing` for text messages,
 * `upload_photo` for photos, `record_video` or `upload_video` for videos,
 * `record_audio` or `upload_audio` for audio files, `upload_document` for general files,
 * `find_location` for location data.
 *
 * @param  {Number|String} chatId  Unique identifier for the message recipient
 * @param  {String} action Type of action to broadcast.
 * @return {Promise}
 * @see https://core.telegram.org/bots/api#sendchataction
 */
TelegramBot.prototype.sendChatAction = function (chatId, action) {
  var query = {
    chat_id: chatId,
    action: action
  };
  return this._request('sendChatAction', {qs: query});
};

/**
 * Send location.
 * Use this method to send point on the map.
 *
 * @param  {Number|String} chatId  Unique identifier for the message recipient
 * @param  {Float} latitude Latitude of location
 * @param  {Float} longitude Longitude of location
 * @param  {Object} [options] Additional Telegram query options
 * @return {Promise}
 * @see https://core.telegram.org/bots/api#sendlocation
 */
TelegramBot.prototype.sendLocation = function (chatId, latitude, longitude, options) {
  var query = options || {};
  query.chat_id = chatId;
  query.latitude = latitude;
  query.longitude = longitude;
  return this._request('sendLocation', {qs: query});
};

module.exports = TelegramBot;
