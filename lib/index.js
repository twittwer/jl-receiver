'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

require('native-promise-only');
var EventEmitter = require('event-emitter'),
    jlClient = require('jl-client');

var sibling = {
  alpha: 'beta',
  beta: 'alpha'
};

var _preprocessModuleConfig = function _preprocessModuleConfig(moduleConfig) {
  if (_typeof(moduleConfig.reconnectTrigger) !== 'object') {
    moduleConfig.reconnectTrigger = {};
  }
  moduleConfig.reconnectTrigger.failure = typeof moduleConfig.reconnectTrigger.failure === 'boolean' ? moduleConfig.reconnectTrigger.failure : true;
  moduleConfig.reconnectTrigger.timeout = typeof moduleConfig.reconnectTrigger.timeout === 'boolean' ? moduleConfig.reconnectTrigger.timeout : true;
  moduleConfig.reconnectTrigger.disconnectByServer = typeof moduleConfig.reconnectTrigger.disconnectByServer === 'boolean' ? moduleConfig.reconnectTrigger.disconnectByServer : true;
  moduleConfig.reconnectTrigger.responseBufferSizeInMB = typeof moduleConfig.reconnectTrigger.responseBufferSizeInMB === 'number' ? moduleConfig.reconnectTrigger.responseBufferSizeInMB : 50;

  moduleConfig.reconnectAttemptLimit = typeof moduleConfig.reconnectAttemptLimit === 'number' ? moduleConfig.reconnectAttemptLimit : 3;
  moduleConfig.reconnectWithHandover = typeof moduleConfig.reconnectWithHandover === 'boolean' ? moduleConfig.reconnectWithHandover : true;

  moduleConfig.reconnectTrigger.responseLength = moduleConfig.reconnectTrigger.responseBufferSizeInMB * 1024 * 1024 / 2;
};

var JlReceiver = function JlReceiver(requestConfig, moduleConfig) {
  this._config = {
    request: requestConfig,
    module: moduleConfig || {}
  };
  this._state = {
    primaryClient: 'alpha',
    connectionAttempt: 1,
    reconnectInProgress: false
  };
  this._clients = {
    alpha: null,
    beta: null
  };

  this._recServer = new EventEmitter();
};

JlReceiver.prototype.connect = function () {
  var _this = this;

  try {
    if (_typeof(this._config.request) !== 'object') {
      throw new Error('Missing Parameter: requestConfig is required');
    }
    _preprocessModuleConfig(this._config.module);
  } catch (error) {
    return Promise.reject(error);
  }

  this._recServer.reconnect = function () {
    _this._reconnectActiveClient(_this._state.primaryClient);
  };
  this._recServer.disconnect = function () {
    var secondaryClient = sibling[_this._state.primaryClient];

    if (_this._clients[_this._state.primaryClient]) {
      _this._clients[_this._state.primaryClient].disconnect();
      _this._clients[_this._state.primaryClient] = null;
    }
    if (_this._clients[secondaryClient]) {
      _this._clients[secondaryClient].disconnect();
      _this._clients[secondaryClient] = null;
    }
  };

  return this._connectClient(this._state.primaryClient).then(function () {
    return _this._recServer;
  });
};

JlReceiver.prototype._connectClient = function (clientName) {
  var _this2 = this;

  if (this._clients[clientName]) {
    this._clients[clientName].disconnect();
    this._clients[clientName] = null;
  }

  return jlClient.connect(this._config.request, this._config.module).then(function (server) {
    _this2._state.connectionAttempt = 1;
    _this2._clients[clientName] = server;

    server.on('data', function (dataPackage) {
      return _this2._handleData(clientName, dataPackage);
    });
    server.on('disconnect', function (error) {
      return _this2._handleDisconnect(clientName, error);
    });
    server.on('heartbeat', function () {
      return _this2._handleHeartbeat(clientName);
    });
    server.on('responseLength', function (responseLength) {
      return _this2._handleResponseLength(clientName, responseLength);
    });
  }).catch(function (error) {
    var reconnect = void 0;

    reconnect = error.message === 'request-timeout' && _this2._config.module.reconnectTrigger.timeout;
    reconnect = reconnect || error.message !== 'request-timeout' && _this2._config.module.reconnectTrigger.failure;
    reconnect = reconnect && _this2._state.connectionAttempt < _this2._config.module.reconnectAttemptLimit;

    if (!reconnect) {
      throw error;
    }

    _this2._state.connectionAttempt += 1;

    return _this2._connectClient(clientName);
  });
};

JlReceiver.prototype._reconnectActiveClient = function (clientName, doHandover) {
  var _this3 = this;

  doHandover = typeof doHandover === 'boolean' ? doHandover : this._config.module.reconnectWithHandover;
  var newClientName = sibling[clientName];

  var directReconnect = function directReconnect() {
    _this3._reconnectActiveClient(clientName, false);
  };

  this._recServer.emit('reconnect');
  this._state.reconnectInProgress = true;

  return this._connectClient(newClientName).then(function () {
    if (!_this3._clients[clientName] || _this3._clients[clientName].isIdle() || !doHandover) {
      _this3._switchClient(clientName, newClientName);
      _this3._recServer.emit('reconnected');
      _this3._state.reconnectInProgress = false;

      return;
    }

    _this3._clients[newClientName].startBuffering('data');
    _this3._clients[newClientName].on('disconnect', directReconnect);

    _this3._clients[clientName].on('data', function () {
      _this3._switchClient(clientName, newClientName);
      _this3._clients[newClientName].removeListener('disconnect', directReconnect);
      _this3._state.reconnectInProgress = false;
      _this3._clients[newClientName].stopBuffering('data');
      _this3._recServer.emit('reconnected');
    });
  }).catch(function (error) {
    _this3._switchClient(clientName, newClientName);
    _this3._recServer.emit('disconnect', error);
    if (_this3._clients[newClientName]) {
      _this3._clients[newClientName].disconnect();
      _this3._clients[newClientName] = null;
    }
  });
};

JlReceiver.prototype._switchClient = function (oldClientName, newClientName) {
  this._state.primaryClient = newClientName;
  if (this._clients[oldClientName]) {
    this._clients[oldClientName].disconnect();
    this._clients[oldClientName] = null;
  }
};

JlReceiver.prototype._handleData = function (clientName, dataPackage) {
  if (this._state.primaryClient === clientName) {
    this._recServer.emit('data', dataPackage);
  }
};

JlReceiver.prototype._handleDisconnect = function (clientName, error) {
  if (this._state.primaryClient === clientName) {
    var reconnect = void 0;

    reconnect = error && this._config.module.reconnectTrigger.failure;
    reconnect = reconnect || !error && this._config.module.reconnectTrigger.disconnectByServer;
    reconnect = reconnect && this._state.connectionAttempt < this._config.module.reconnectAttemptLimit;

    if (reconnect) {
      this._reconnectActiveClient(clientName, false);

      return;
    }
    this._recServer.emit('disconnect', error);
  } else if (this._state.reconnectInProgress) {
    return;
  }
  this._clients[clientName] = null;
};

JlReceiver.prototype._handleHeartbeat = function (clientName) {
  if (this._state.primaryClient === clientName) {
    this._recServer.emit('heartbeat');
  }
};

JlReceiver.prototype._handleResponseLength = function (clientName, responseLength) {
  if (this._state.primaryClient === clientName) {
    if (this._state.reconnectInProgress) {
      return;
    }
    if (responseLength > this._config.module.reconnectTrigger.responseLength) {
      this._reconnectActiveClient(clientName);
    }
  }
};

module.exports = {
  connect: function connect(requestConfig, moduleConfig) {
    return new JlReceiver(requestConfig, moduleConfig).connect();
  }
};