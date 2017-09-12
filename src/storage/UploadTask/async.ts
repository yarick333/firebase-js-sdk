/**
* Copyright 2017 Google Inc.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

import { InternalTaskState } from '../implementation/taskenums';
import { UploadTask } from './core';
import {
  taskStateFromInternalTaskState,
  TaskState
} from '../implementation/taskenums';
import { async as fbsAsync } from '../implementation/async';
import { FbsBlob } from '../implementation/blob';
import { remove } from '../implementation/array';
import { Observer } from '../implementation/observer';
import { Code } from '../implementation/error';
import { UploadTaskSnapshot } from '../tasksnapshot';

/**
 * Patch original `UploadTask` object to have the new 
 * methods that we need
 */
declare module './core' {
  interface UploadTask {
    _chunkMultiplier: number;
    _errorHandler;
    _metadataErrorHandler;
    _observers: any[];
    _request;
    _transferred: number;
    _uploadUrl;
    _needToFetchStatus: boolean;
    _needToFetchMetadata: boolean;
    snapshot;
    _addObserver(observer: Observer<UploadTaskSnapshot>): void;
    _continueUpload(): void;
    _completeTransitions(): void;
    _createResumable(): void;
    _fetchStatus(): void;
    _fetchMetadata(): void;
    _finishPromise(): void;
    _increaseMultiplier(): void;
    _makeProgressCallback(): (p1: number, p2: number) => void;
    _notifyObserver(observer): void;
    _notifyObservers(): void;
    _oneShotUpload(): void;
    _removeObserver(observer: Observer<UploadTaskSnapshot>): void;
    _resolveToken(callback: (p1: string | null) => void): void;
    _start(): void;
    _shouldDoResumable(blob: FbsBlob): boolean;
    _updateProgress(transferred: number): void;
  }
}

Object.assign(UploadTask.prototype, {
  /**
   * Adds the given observer.
   */
  _addObserver(observer: Observer<UploadTaskSnapshot>) {
    const self = this as UploadTask;
    self._observers = self._observers || [];
    self._observers.push(observer);
    self._notifyObserver(observer);
  },
  _completeTransitions() {
    const self = this as UploadTask;
    switch (self._state) {
      case InternalTaskState.PAUSING:
        self.transition(InternalTaskState.PAUSED);
        break;
      case InternalTaskState.CANCELING:
        self.transition(InternalTaskState.CANCELED);
        break;
      case InternalTaskState.RUNNING:
        self._start();
        break;
      default:
        // TODO(andysoto): assert(false);
        break;
    }
  },
  _continueUpload() {
    const self = this as UploadTask;

    // Default init for _chunkMultiplier
    self._chunkMultiplier = self._chunkMultiplier || 1;

    import('../implementation/requests').then(module => {
      const chunkSize = module.resumableUploadChunkSize * self._chunkMultiplier;
      const status = new module.ResumableUploadStatus(
        self._transferred,
        self.blob.size()
      );

      // TODO(andysoto): assert(self.uploadUrl_ !== null);
      const url = self._uploadUrl as string;
      self._resolveToken(authToken => {
        let requestInfo;
        try {
          requestInfo = module.continueResumableUpload(
            self.location,
            self.authWrapper,
            url,
            self.blob,
            chunkSize,
            self.mappings,
            status,
            self._makeProgressCallback()
          );
        } catch (e) {
          self._error = e;
          self.transition(InternalTaskState.ERROR);
          return;
        }
        const uploadRequest = self.authWrapper.makeRequest(
          requestInfo,
          authToken
        );
        self._request = uploadRequest;
        uploadRequest.getPromise().then(newStatus => {
          self._increaseMultiplier();
          self._request = null;
          self._updateProgress(newStatus.current);
          if (newStatus.finalized) {
            self.metadata = newStatus.metadata;
            self.transition(InternalTaskState.SUCCESS);
          } else {
            self._completeTransitions();
          }
        }, self._errorHandler);
      });
    });
  },
  _createResumable() {
    const self = this as UploadTask;

    // Default init for _needToFetchStatus
    self._needToFetchStatus = self._needToFetchStatus || false;

    self._resolveToken(authToken => {
      import('../implementation/requests').then(module => {
        const requestInfo = module.createResumableUpload(
          self.authWrapper,
          self.location,
          self.mappings,
          self.blob,
          self.metadata
        );
        const createRequest = self.authWrapper.makeRequest(
          requestInfo,
          authToken
        );
        self._request = createRequest;
        createRequest.getPromise().then((url: string) => {
          self._request = null;
          self._uploadUrl = url;
          self._needToFetchStatus = false;
          self._completeTransitions();
        }, self._errorHandler);
      });
    });
  },
  _fetchMetadata() {
    const self = this as UploadTask;

    self._resolveToken(authToken => {
      import('../implementation/requests').then(module => {
        const requestInfo = module.getMetadata(
          self.authWrapper,
          self.location,
          self.mappings
        );
        const metadataRequest = self.authWrapper.makeRequest(
          requestInfo,
          authToken
        );
        self._request = metadataRequest;
        metadataRequest.getPromise().then(metadata => {
          self._request = null;
          self.metadata = metadata;
          self.transition(InternalTaskState.SUCCESS);
        }, self._metadataErrorHandler);
      });
    });
  },
  _fetchStatus() {
    const self = this as UploadTask;

    // Default init for _needToFetchStatus
    self._needToFetchStatus = self._needToFetchStatus || false;
    self._needToFetchMetadata = self._needToFetchMetadata || false;

    // TODO(andysoto): assert(self.uploadUrl_ !== null);
    const url = self._uploadUrl as string;
    self._resolveToken(authToken => {
      import('../implementation/requests').then(module => {
        const requestInfo = module.getResumableUploadStatus(
          self.authWrapper,
          self.location,
          url,
          self.blob
        );
        const statusRequest = self.authWrapper.makeRequest(
          requestInfo,
          authToken
        );
        self._request = statusRequest;

        statusRequest.getPromise().then(status => {
          self._request = null;
          self._updateProgress(status.current);
          self._needToFetchStatus = false;
          if (status.finalized) {
            self._needToFetchMetadata = true;
          }
          self._completeTransitions();
        }, self._errorHandler);
      });
    });
  },
  _finishPromise() {
    const self = this as UploadTask;

    if (self._resolve !== null) {
      let triggered = true;
      switch (taskStateFromInternalTaskState(self._state)) {
        case TaskState.SUCCESS:
          fbsAsync(self._resolve.bind(null, self.snapshot))();
          break;
        case TaskState.CANCELED:
        case TaskState.ERROR:
          const toCall = self._reject as ((p1: Error) => void);
          fbsAsync(toCall.bind(null, self._error as Error))();
          break;
        default:
          triggered = false;
          break;
      }
      if (triggered) {
        self._resolve = null;
        self._reject = null;
      }
    }
  },
  _increaseMultiplier() {
    const self = this as UploadTask;

    // Default init for _chunkMultiplier
    self._chunkMultiplier = self._chunkMultiplier || 1;

    import('../implementation/requests').then(module => {
      const currentSize =
        module.resumableUploadChunkSize * self._chunkMultiplier;

      // Max chunk size is 32M.
      if (currentSize < 32 * 1024 * 1024) {
        self._chunkMultiplier *= 2;
      }
    });
  },
  _makeProgressCallback(): (p1: number, p2: number) => void {
    const self = this as UploadTask;
    const sizeBefore = self._transferred;
    return (loaded, total) => {
      self._updateProgress(sizeBefore + loaded);
    };
  },
  _notifyObserver(observer) {
    const self = this as UploadTask;

    const externalState = taskStateFromInternalTaskState(self._state);
    switch (externalState) {
      case TaskState.RUNNING:
      case TaskState.PAUSED:
        if (observer.next !== null) {
          fbsAsync(observer.next.bind(observer, self.snapshot))();
        }
        break;
      case TaskState.SUCCESS:
        if (observer.complete !== null) {
          fbsAsync(observer.complete.bind(observer))();
        }
        break;
      case TaskState.CANCELED:
      case TaskState.ERROR:
        if (observer.error !== null) {
          fbsAsync(observer.error.bind(observer, self._error as Error))();
        }
        break;
      default:
        if (observer.error !== null) {
          fbsAsync(observer.error.bind(observer, self._error as Error))();
        }
    }
  },
  _notifyObservers() {
    const self = this as UploadTask;

    self._finishPromise();
    self._observers = self._observers || [];
    const observers = [...self._observers];
    observers.forEach(observer => {
      self._notifyObserver(observer);
    });
  },
  _oneShotUpload() {
    const self = this as UploadTask;

    self._resolveToken(authToken => {
      import('../implementation/requests').then(module => {
        const requestInfo = module.multipartUpload(
          self.authWrapper,
          self.location,
          self.mappings,
          self.blob,
          self.metadata
        );
        const multipartRequest = self.authWrapper.makeRequest(
          requestInfo,
          authToken
        );
        self._request = multipartRequest;
        multipartRequest.getPromise().then(metadata => {
          self._request = null;
          self.metadata = metadata;
          self._updateProgress(self.blob.size());
          self.transition(InternalTaskState.SUCCESS);
        }, self._errorHandler);
      });
    });
  },
  _removeObserver(observer: Observer<UploadTaskSnapshot>) {
    const self = this as UploadTask;
    self._observers = self._observers || [];
    remove(self._observers, observer);
  },
  _resolveToken(callback: (p1: string | null) => void) {
    const self = this as UploadTask;

    self.authWrapper.getAuthToken().then(authToken => {
      switch (self._state) {
        case InternalTaskState.RUNNING:
          callback(authToken);
          break;
        case InternalTaskState.CANCELING:
          self.transition(InternalTaskState.CANCELED);
          break;
        case InternalTaskState.PAUSING:
          self.transition(InternalTaskState.PAUSED);
          break;
        default:
      }
    });
  },
  _shouldDoResumable(blob: FbsBlob): boolean {
    return blob.size() > 256 * 1024;
  },
  _start() {
    const self = this as UploadTask;

    // This can happen if someone pauses us in a resume callback, for example.
    if (self._state !== InternalTaskState.RUNNING) return;
    if (self._request) return;

    if (self._shouldDoResumable(self.blob)) {
      if (!self._uploadUrl) {
        self._createResumable();
      } else {
        if (self._needToFetchStatus) {
          self._fetchStatus();
        } else {
          if (self._needToFetchMetadata) {
            // Happens if we miss the metadata on upload completion.
            self._fetchMetadata();
          } else {
            self._continueUpload();
          }
        }
      }
    } else {
      self._oneShotUpload();
    }
  },
  _updateProgress(transferred: number) {
    const self = this as UploadTask;

    // Default init for _transferred
    self._transferred = self._transferred || 0;

    const old = self._transferred;
    self._transferred = transferred;

    // A progress update can make the "transferred" value smaller (e.g. a
    // partial upload not completed by server, after which the "transferred"
    // value may reset to the value at the beginning of the request).
    if (self._transferred !== old) {
      self._notifyObservers();
    }
  }
});

Object.defineProperties(UploadTask.prototype, {
  _errorHandler: {
    get: function() {
      const self = this as UploadTask;

      return error => {
        self._request = null;
        self._chunkMultiplier = 1;
        if (error.codeEquals(Code.CANCELED)) {
          self._needToFetchStatus = true;
          self._completeTransitions();
        } else {
          self._error = error;
          self.transition(InternalTaskState.ERROR);
        }
      };
    }
  },
  _metadataErrorHandler: {
    get: function() {
      const self = this as UploadTask;

      return error => {
        self._request = null;
        if (error.codeEquals(Code.CANCELED)) {
          self._completeTransitions();
        } else {
          self._error = error;
          self.transition(InternalTaskState.ERROR);
        }
      };
    }
  },
  snapshot: {
    get: function() {
      const self = this as UploadTask;

      const externalState = taskStateFromInternalTaskState(self._state);
      return new UploadTaskSnapshot(
        self._transferred,
        self.blob.size(),
        externalState,
        self.metadata,
        self,
        self.ref
      );
    }
  }
});
