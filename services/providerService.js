/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const bunyan = require('bunyan'),
  _ = require('lodash'),
  config = require('../config'),
  Web3 = require('web3'),
  sem = require('semaphore')(1),
  net = require('net'),
  providerServiceInterface = require('middleware-common-components/interfaces/blockProcessor/providerServiceInterface'),
  Promise = require('bluebird'),
  EventEmitter = require('events'),
  log = bunyan.createLogger({name: 'core.blockProcessor.services.syncCacheService', level: config.logs.level});

/**
 * @service
 * @description the service for handling connection to node
 * @returns Object<ProviderService>
 */

class providerService {

  constructor () {
    this.events = new EventEmitter();
    this.connector = null;
    this.filter = null;

    if (config.web3.providers.length > 1)
      this.findBestNodeInterval = setInterval(() => {
        this.switchConnectorSafe();
      }, 60000 * 5);
  }

  /**
   * @function
   * @description build web3 instance from provided URI
   * @param providerURI - the connection uri
   * @return {Web3}
   */
  makeWeb3FromProviderURI (providerURI) {

    const provider = /^http/.test(providerURI) ?
      new Web3.providers.HttpProvider(providerURI) :
      new Web3.providers.IpcProvider(`${/^win/.test(process.platform) ? '\\\\.\\pipe\\' : ''}${providerURI}`, net);

    const web3 = new Web3();
    web3.setProvider(provider);
    return web3;
  }

  /** @function
   * @description reset the current connection
   * @return {Promise<void>}
   */
  async resetConnector () {
    await this.connector.reset();
    this.switchConnector();
    this.events.emit('disconnected');
  }

  /**
   * @function
   * @description choose the connector
   * @return {Promise<null|*>}
   */
  async switchConnector () {

    const providerURI = await Promise.any(config.web3.providers.map(async providerURI => {
      const web3 = this.makeWeb3FromProviderURI(providerURI);
      await Promise.promisify(web3.eth.getBlockNumber)().timeout(5000);
      web3.reset();
      return providerURI;
    })).catch(() => {
      log.error('no available connection!');
      process.exit(0);
    });

    const fullProviderURI = !/^http/.test(providerURI) ? `${/^win/.test(process.platform) ? '\\\\.\\pipe\\' : ''}${providerURI}` : providerURI;
    const currentProviderURI = this.connector ? this.connector.currentProvider.path || this.connector.currentProvider.host : '';

    if (currentProviderURI === fullProviderURI)
      return;

    this.connector = this.makeWeb3FromProviderURI(providerURI);

    if (_.get(this.connector.currentProvider, 'connection')) {
      this.connector.currentProvider.connection.on('end', () => this.resetConnector());
      this.connector.currentProvider.connection.on('error', () => this.resetConnector());
    } else 
      this.pingIntervalId = setInterval(async () => {

        const isConnected = await new Promise((res, rej) => {
          this.connector.currentProvider.sendAsync({
            id: 9999999999,
            jsonrpc: '2.0',
            method: 'net_listening',
            params: []
          }, (err, result) => err ? rej(err) : res(result.result));
        });

        if (!isConnected) {
          clearInterval(this.pingIntervalId);
          this.resetConnector();
        }
      }, 5000);
    

    this.filter = this.connector.eth.filter('pending');
    this.filter.watch((err, result) => {
      if (!err)
        this.events.emit('unconfirmedTx', result);
    });

    this.events.emit('provider_set');
    return this.connector;

  }

  /**
   * @function
   * @description safe connector switching, by moving requests to
   * @return {Promise<bluebird>}
   */
  async switchConnectorSafe () {

    return new Promise(res => {
      sem.take(async () => {
        await this.switchConnector();
        res(this.connector);
        sem.leave();
      });
    });
  }

  /**
   * @function
   * @description
   * @return {Promise<*|bluebird>}
   */
  async get () {
    return this.connector && this.connector.isConnected() ? this.connector : await this.switchConnectorSafe();
  }

}

module.exports = providerServiceInterface(new providerService());
