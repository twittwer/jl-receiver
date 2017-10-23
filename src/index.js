'use strict';

require('native-promise-only');
const EventEmitter = require('event-emitter'),
  jlClient = require('jl-client');

/* -------------- */
/* --- Helper --- */
/* -------------- */

const sibling = {
  alpha: 'beta',
  beta: 'alpha'
};

/* -------------------------------- */
/* --- Configuration Management --- */
/* -------------------------------- */

const _preprocessModuleConfig = moduleConfig => {
  if (typeof moduleConfig.reconnectTrigger !== 'object') {
    moduleConfig.reconnectTrigger = {};
  }
  moduleConfig.reconnectTrigger.failure = typeof moduleConfig.reconnectTrigger.failure === 'boolean' ? moduleConfig.reconnectTrigger.failure : true;
  moduleConfig.reconnectTrigger.timeout = typeof moduleConfig.reconnectTrigger.timeout === 'boolean' ? moduleConfig.reconnectTrigger.timeout : true;
  moduleConfig.reconnectTrigger.disconnectByServer = typeof moduleConfig.reconnectTrigger.disconnectByServer === 'boolean' ? moduleConfig.reconnectTrigger.disconnectByServer : true;
  moduleConfig.reconnectTrigger.responseBufferSizeInMB = typeof moduleConfig.reconnectTrigger.responseBufferSizeInMB === 'number' ? moduleConfig.reconnectTrigger.responseBufferSizeInMB : 50;

  moduleConfig.reconnectAttemptLimit = typeof moduleConfig.reconnectAttemptLimit === 'number' ? moduleConfig.reconnectAttemptLimit : 3;
  moduleConfig.reconnectWithHandover = typeof moduleConfig.reconnectWithHandover === 'boolean' ? moduleConfig.reconnectWithHandover : true;

  /* convert limitation from megabyte to character count (1 megabyte = 1024 kilobyte; 1 kilobyte = 1024 byte; 2 byte = 1 string character) */
  moduleConfig.reconnectTrigger.responseLength = (moduleConfig.reconnectTrigger.responseBufferSizeInMB * 1024 * 1024) / 2;
};

/* ---------------------- */
/* --- Initialization --- */
/* ---------------------- */

const JlReceiver = function(requestConfig, moduleConfig) {
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

JlReceiver.prototype.connect = function() {
  try {
    if (typeof this._config.request !== 'object') {
      throw new Error('Missing Parameter: requestConfig is required');
    }
    _preprocessModuleConfig(this._config.module);
  } catch (error) {
    return Promise.reject(error);
  }

  this._recServer.reconnect = () => {
    this._reconnectActiveClient(this._state.primaryClient);
  };
  this._recServer.disconnect = () => {
    const secondaryClient = sibling[this._state.primaryClient];

    if (this._clients[this._state.primaryClient]) {
      this._clients[this._state.primaryClient].disconnect();
      this._clients[this._state.primaryClient] = null;
    }
    if (this._clients[secondaryClient]) {
      this._clients[secondaryClient].disconnect();
      this._clients[secondaryClient] = null;
    }
  };

  return this._connectClient(this._state.primaryClient).then(() => {
    return this._recServer;
  });
};

/* --------------------------- */
/* --- Connection Handling --- */
/* --------------------------- */

JlReceiver.prototype._connectClient = function(clientName) {
  if (this._clients[clientName]) {
    this._clients[clientName].disconnect();
    this._clients[clientName] = null;
  }

  return jlClient.connect(this._config.request, this._config.module)
    .then(server => {
      this._state.connectionAttempt = 1;
      this._clients[clientName] = server;

      /* eslint-disable arrow-body-style */
      server.on('data', dataPackage => this._handleData(clientName, dataPackage));
      server.on('disconnect', error => this._handleDisconnect(clientName, error));
      server.on('heartbeat', () => this._handleHeartbeat(clientName));
      server.on('responseLength', responseLength => this._handleResponseLength(clientName, responseLength));
      /* eslint-enable arrow-body-style */
    })
    .catch(error => {
      let reconnect;

      reconnect = (error.message === 'request-timeout') && this._config.module.reconnectTrigger.timeout;
      reconnect = reconnect || ((error.message !== 'request-timeout') && this._config.module.reconnectTrigger.failure);
      reconnect = reconnect && (this._state.connectionAttempt < this._config.module.reconnectAttemptLimit);

      if (!reconnect) {
        throw error;
      }

      this._state.connectionAttempt += 1;

      return this._connectClient(clientName);
    });
};

JlReceiver.prototype._reconnectActiveClient = function(clientName, doHandover) {
  doHandover = typeof doHandover === 'boolean' ? doHandover : this._config.module.reconnectWithHandover;
  const newClientName = sibling[clientName];

  const directReconnect = () => {
    this._reconnectActiveClient(clientName, false);
  };

  this._recServer.emit('reconnect');
  this._state.reconnectInProgress = true;

  return this._connectClient(newClientName)
    .then(() => {
      if (!this._clients[clientName] || this._clients[clientName].isIdle() || !doHandover) {
        this._switchClient(clientName, newClientName);
        this._recServer.emit('reconnected');
        this._state.reconnectInProgress = false;

        return;
      }
      /* console.log('<stream> doHandover'); */

      this._clients[newClientName].startBuffering('data');
      this._clients[newClientName].on('disconnect', directReconnect);

      this._clients[clientName].on('data', () => {
        this._switchClient(clientName, newClientName);
        this._clients[newClientName].removeListener('disconnect', directReconnect);
        this._state.reconnectInProgress = false;
        this._clients[newClientName].stopBuffering('data');
        this._recServer.emit('reconnected');
      });
    })
    .catch(error => {
      this._switchClient(clientName, newClientName);
      this._recServer.emit('disconnect', error);
      if (this._clients[newClientName]) {
        this._clients[newClientName].disconnect();
        this._clients[newClientName] = null;
      }
    });
};

JlReceiver.prototype._switchClient = function(oldClientName, newClientName) {
  this._state.primaryClient = newClientName;
  if (this._clients[oldClientName]) {
    this._clients[oldClientName].disconnect();
    this._clients[oldClientName] = null;
  }
};

/* ---------------------- */
/* --- Event Handling --- */
/* ---------------------- */

JlReceiver.prototype._handleData = function(clientName, dataPackage) {
  if (this._state.primaryClient === clientName) {
    this._recServer.emit('data', dataPackage);
  }
};

JlReceiver.prototype._handleDisconnect = function(clientName, error) {
  if (this._state.primaryClient === clientName) {
    let reconnect;

    reconnect = error && this._config.module.reconnectTrigger.failure;
    reconnect = reconnect || (!error && this._config.module.reconnectTrigger.disconnectByServer);
    reconnect = reconnect && (this._state.connectionAttempt < this._config.module.reconnectAttemptLimit);

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

JlReceiver.prototype._handleHeartbeat = function(clientName) {
  if (this._state.primaryClient === clientName) {
    this._recServer.emit('heartbeat');
  }
};

JlReceiver.prototype._handleResponseLength = function(clientName, responseLength) {
  if (this._state.primaryClient === clientName) {
    if (this._state.reconnectInProgress) {
      return;
    }
    if (responseLength > this._config.module.reconnectTrigger.responseLength) {
      this._reconnectActiveClient(clientName);
    }
  }
};

/* -------------- */
/* --- Export --- */
/* -------------- */

module.exports = {
  connect: (requestConfig, moduleConfig) => {
    return (new JlReceiver(requestConfig, moduleConfig)).connect();
  }
};
