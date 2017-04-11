import {ILoadOrder} from '../types/ILoadOrder';
import {nativePlugins, pluginFormat, pluginPath} from '../util/gameSupport';

import * as Promise from 'bluebird';
import * as fs from 'fs-extra-promise';
import {decode, encode} from 'iconv-lite';
import {log, types, util} from 'nmm-api';
import * as path from 'path';

export type PluginFormat = 'original' | 'fallout4';

type PluginMap = { [name: string]: ILoadOrder };

const retryCount = 3;

/**
 * persistor syncing to and from the gamebryo plugins.txt and loadorder.txt
 * 
 * @class PluginPersistor
 * @implements {types.IPersistor}
 */
class PluginPersistor implements types.IPersistor {
  private mPluginPath: string;
  private mPluginFormat: PluginFormat;
  private mNativePlugins: Set<string>;
  private mResetCallback: () => void;

  private mWatch: fs.FSWatcher;
  private mRefreshTimer: NodeJS.Timer;
  private mSerializing: boolean = false;
  private mSerializeQueue: Promise<void> = Promise.resolve();

  private mPlugins: PluginMap;
  private mRetryCounter: number = retryCount;
  private mLoaded: boolean = false;

  constructor() {
    this.mPlugins = {};
  }

  public loadFiles(gameMode: string) {
    this.mPluginPath = pluginPath(gameMode);
    this.mPluginFormat = pluginFormat(gameMode);
    this.mNativePlugins = new Set(nativePlugins(gameMode));
    // read the files now and update the store
    this.deserialize();
    // start watching for external changes
    this.startWatch();
  }

  /**
   * immediately stops all syncing with the files on disc
   * This should be used to prevent file corruption when switching
   * game mode
   */
  public stopSync() {
    this.mPluginPath = undefined;
    this.mPluginFormat = undefined;
    this.mNativePlugins = undefined;

    if (this.mWatch !== undefined) {
      this.mWatch.close();
      this.mWatch = undefined;
    }
  }

  public setResetCallback(cb: () => void) {
    this.mResetCallback = cb;
  }

  public getItem(key: string, cb: (error: Error, result?: string) => void): void {
    cb(null, JSON.stringify(this.mPlugins));
  }

  public setItem(key: string, value: string, cb: (error: Error) => void): void {
    this.mPlugins = JSON.parse(value);
    this.serialize().then(() => cb(null));
  }

  public removeItem(key: string, cb: (error: Error) => void): void {
    delete this.mPlugins[key];
    this.serialize().then(() => cb(null));
  }

  public getAllKeys(cb: (error: Error, keys?: string[]) => void): void {
    cb(null, ['loadOrder']);
  }

  private toPluginList(input: string[]) {
    if (this.mPluginFormat === 'original') {
      return this.toPluginListOriginal(input);
    } else {
      return this.toPluginListFallout4(input);
    }
  }

  private toPluginListOriginal(input: string[]) {
    return input.filter(
        (pluginName: string) => { return this.mPlugins[pluginName].enabled; });
  }

  private toPluginListFallout4(input: string[]) {
    return input.map((name: string) => {
      if (util.getSafe(this.mPlugins, [name, 'enabled'], false)) {
        return '*' + name;
      } else {
        return name;
      }
    });
  }

  private serialize(): Promise<void> {
    if (!this.mLoaded) {
      // this happens during initialization, when the persistor is initially created, with default
      // values.
      return Promise.resolve();
    }
    // ensure we don't try to concurrently write the files
    this.mSerializeQueue = this.mSerializeQueue.then(() => {
      this.doSerialize();
    });
    return this.mSerializeQueue;
  }

  private doSerialize(): Promise<void> {
    if (this.mPluginPath === undefined) {
      return;
    }

    this.mSerializing = true;

    let sorted: string[] =
        Object.keys(this.mPlugins)
            .filter((pluginName: string) =>
                        !this.mNativePlugins.has(pluginName.toLowerCase()))
            .sort((lhs: string, rhs: string) => this.mPlugins[lhs].loadOrder -
                                                this.mPlugins[rhs].loadOrder);

    return fs.writeFileAsync(path.join(this.mPluginPath, 'loadorder.txt'),
      encode('# Automatically generated by NMM2\r\n' + sorted.join('\r\n'), 'utf-8'))
      .then(() => {
        let filtered: string[] = this.toPluginList(sorted);
        return fs.writeFileAsync(path.join(this.mPluginPath, 'plugins.txt'),
          encode('# Automatically generated by NMM2\r\n' + filtered.join('\r\n'), 'latin-1'));
      })
      .catch((err) => {
        // TODO: report to the user? The problem is that this might occur repeatedly so we
        //   need to be careful to not spam the user
        log('error', 'failed to write plugin list', { err });
      })
      .finally(() => {
        this.mSerializing = false;
      })
      ;
  }

  private filterFileData(input: string, plugins: boolean): string[] {
    let res = input.split(/\r?\n/).filter((value: string) => {
        return !value.startsWith('#') && (value.length > 0);
      });

    return res;
  }

  private initFromKeyList(plugins: PluginMap, keys: string[], enabled: boolean) {
    let loadOrderPos = Object.keys(plugins).length;
    keys.forEach((key: string) => {
      let keyEnabled = enabled && ((this.mPluginFormat === 'original') || (key[0] === '*'));
      if ((this.mPluginFormat === 'fallout4') && (key[0] === '*')) {
        key = key.slice(1);
      }
      // ignore "native" plugins
      if (this.mNativePlugins.has(key.toLowerCase())) {
        return;
      }
      if (plugins[key] !== undefined) {
        plugins[key].enabled = keyEnabled;
      } else {
        plugins[key] = {
          enabled: keyEnabled,
          loadOrder: loadOrderPos++,
        };
      }
    });
  }

  private deserialize(): Promise<void> {
    if (this.mPluginPath === undefined) {
      return;
    }

    let newPlugins: PluginMap = {};

    let phaseOne: Promise<NodeBuffer>;
    if (this.mPluginFormat === 'original') {
      phaseOne = fs.readFileAsync(path.join(this.mPluginPath, 'loadorder.txt'))
                     .then((data: NodeBuffer) => {
                       let keys: string[] =
                           this.filterFileData(decode(data, 'utf-8'), false);
                       this.initFromKeyList(newPlugins, keys, false);
                       return fs.readFileAsync(
                           path.join(this.mPluginPath, 'plugins.txt'));
                     });
    } else {
      phaseOne = fs.readFileAsync(path.join(this.mPluginPath, 'plugins.txt'));
    }
    return phaseOne
    .then((data: NodeBuffer) => {
      if (data.length === 0) {
        // not even a header? I don't trust this
        // TODO: This is just a workaround
        return Promise.reject(new Error('empty file encountered'));
      }
      let keys: string[] = this.filterFileData(decode(data, 'latin-1'), true);
      this.initFromKeyList(newPlugins, keys, true);
      this.mPlugins = newPlugins;
      if (this.mResetCallback) {
        this.mLoaded = true;
        this.mResetCallback();
        this.mRetryCounter = retryCount;
      }
    })
    .catch((err: Error) => {
      log('warn', 'failed to read plugin file', this.mPluginPath);
      if (this.mRetryCounter > 0) {
        --this.mRetryCounter;
        this.scheduleRefresh(100);
      }
    });
  }

  private scheduleRefresh(timeout: number) {
    if (this.mRefreshTimer !== null) {
      clearTimeout(this.mRefreshTimer);
    }
    this.mRefreshTimer = setTimeout(() => {
      this.mRefreshTimer = null;
      this.deserialize();
    }, timeout);
  }

  private startWatch() {
    if (this.mWatch !== undefined) {
      this.mWatch.close();
    }

    if (this.mPluginPath === undefined) {
      return;
    }

    try {
      this.mWatch = fs.watch(this.mPluginPath, {}, (evt, fileName: string) => {
        if (!this.mSerializing &&
                ['loadorder.txt', 'plugins.txt'].indexOf(fileName) !== -1) {
          this.scheduleRefresh(500);
        }
      });
    } catch (err) {
      log('error', 'failed to look for plugin changes', {
        pluginPath: this.mPluginPath, err,
      });
    }
  }
}

export default PluginPersistor;
