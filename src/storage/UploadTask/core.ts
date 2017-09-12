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

import { Location } from '../implementation/location';
import { Mappings } from '../implementation/metadata';
import { FbsBlob } from '../implementation/blob';
import { Metadata } from '../metadata';
import { InternalTaskState } from '../implementation/taskenums';
import {
  validate,
  nullFunctionSpec,
  looseObjectSpec,
  stringSpec,
  ArgSpec
} from '../implementation/args';
import { canceled } from '../implementation/error';
import { TaskEvent } from '../implementation/taskenums';
import { Deferred } from '../../utils/promise';
import {
  Observer,
  Subscribe,
  NextFn,
  ErrorFn,
  CompleteFn
} from '../implementation/observer';

export class UploadTask {
  /**
   * Statically initialized class states
   */
  _error;
  _request;
  _state = InternalTaskState.RUNNING;
  _resolve: ((p1) => void) | null = null;
  _reject: ((p1: Error) => void) | null = null;
  _promise: Promise<any>;

  /**
   * @param ref The firebaseStorage.Reference object this task came
   *     from, untyped to avoid cyclic dependencies.
   * @param blob The blob to upload.
   */
  constructor(
    public ref,
    public authWrapper,
    public location: Location,
    public mappings: Mappings,
    public blob: FbsBlob,
    public metadata: Metadata | null = null
  ) {
    /**
     * Fetch the async portions of the API (deferred to optimize 
     * for first load)
     */
    const importAsync = import('./async');

    // Setup Promise Behavior
    const dfd = new Deferred();
    this._promise = importAsync.then(() => dfd.promise);
    this._resolve = dfd.resolve;
    this._reject = dfd.reject;

    // Start upload
    this.start();
  }

  async notifyObservers() {
    await import('./async');
    this._notifyObservers();
  }

  async start() {
    await import('./async');
    this._start();
  }

  transition(state: InternalTaskState) {
    // Early return if we don't need to transition the state
    if (this._state === state) return;
    switch (state) {
      case InternalTaskState.CANCELING:
        this._state = state;
        if (this._request && this._request.cancel) {
          this._request.cancel();
        }
        break;
      case InternalTaskState.PAUSING:
        this._state = state;
        if (this._request && this._request.cancel) {
          this._request.cancel();
        }
        break;
      case InternalTaskState.RUNNING:
        const wasPaused = this._state === InternalTaskState.PAUSED;
        this._state = state;
        if (wasPaused) {
          this.notifyObservers();
          this.start();
        }
        break;
      case InternalTaskState.PAUSED:
        this._state = state;
        this.notifyObservers();
        break;
      case InternalTaskState.CANCELED:
        this._error = canceled();
        this._state = state;
        this.notifyObservers();
        break;
      case InternalTaskState.ERROR:
        this._state = state;
        this.notifyObservers();
        break;
      case InternalTaskState.SUCCESS:
        this._state = state;
        this.notifyObservers();
        break;
    }
  }

  /**
   * Cancels a currently running or paused task. Has no effect on a complete or
   * failed task.
   * @return True if the operation took effect, false if ignored.
   */
  cancel(...args): boolean {
    validate('cancel', [], args);
    const valid =
      this._state === InternalTaskState.RUNNING ||
      this._state === InternalTaskState.PAUSING;
    if (valid) {
      this.transition(InternalTaskState.CANCELING);
    }
    return valid;
  }

  /**
   * Equivalent to calling `then(null, onRejected)`.
   */
  catch<T>(onRejected: (p1: Error) => T | PromiseLike<T>): Promise<T> {
    return this.then(null, onRejected);
  }

  /**
   * Adds a callback for an event.
   * @param type The type of event to listen for.
   */
  on(...args) {
    const [type, nextOrObserver, error, completed] = args as [
      TaskEvent,
      any,
      any,
      any
    ];

    const nextOrObserverMessage =
      'Expected a function or an Object with one of ' +
      '`next`, `error`, `complete` properties.';
    const nextValidator = nullFunctionSpec(true).validator;
    const observerValidator = looseObjectSpec(null, true).validator;

    // String Spec Validator
    function typeValidator(_p: any) {
      if (type !== TaskEvent.STATE_CHANGED) {
        throw `Expected one of the event types: [${TaskEvent.STATE_CHANGED}].`;
      }
    }

    // Loose Object Validator
    function nextOrObserverValidator(p: any) {
      try {
        nextValidator(p);
        return;
      } catch (e) {}
      try {
        observerValidator(p);
        const anyDefined = p['next'] || p['error'] || p['complete'];
        if (!anyDefined) {
          throw '';
        }
        return;
      } catch (e) {
        throw nextOrObserverMessage;
      }
    }

    const specs = [
      stringSpec(typeValidator),
      looseObjectSpec(nextOrObserverValidator, true),
      nullFunctionSpec(true),
      nullFunctionSpec(true)
    ];
    validate('on', specs, args);

    const self = this;
    const importPromise = import('./async');

    function makeBinder(specs: ArgSpec[] | null): Subscribe<any> {
      function binder(
        nextOrObserver: NextFn<any> | { [name: string]: string | null } | null,
        error?: ErrorFn | null,
        opt_complete?: CompleteFn | null
      ) {
        if (specs !== null) {
          validate('on', specs, arguments);
        }
        const observer = new Observer(nextOrObserver, error, completed);
        importPromise.then(() => {
          self._addObserver(observer);
        });
        return () => {
          importPromise.then(() => {
            self._removeObserver(observer);
          });
        };
      }
      return binder;
    }

    function binderNextOrObserverValidator(p: any) {
      if (p === null) {
        throw nextOrObserverMessage;
      }
      nextOrObserverValidator(p);
    }
    const binderSpecs = [
      looseObjectSpec(binderNextOrObserverValidator),
      nullFunctionSpec(true),
      nullFunctionSpec(true)
    ];
    const typeOnly = !(nextOrObserver || error || completed);
    if (typeOnly) {
      return makeBinder(binderSpecs);
    } else {
      return makeBinder(null)(nextOrObserver, error, completed);
    }
  }

  /**
   * Pauses a currently running task. Has no effect on a paused or failed task.
   * @return True if the operation took effect, false if ignored.
   */
  pause(...args): boolean {
    validate('pause', [], args);
    const valid = this._state === InternalTaskState.RUNNING;
    if (valid) {
      this.transition(InternalTaskState.PAUSING);
    }
    return valid;
  }

  /**
   * Resumes a paused task. Has no effect on a currently running or failed task.
   * @return True if the operation took effect, false if ignored.
   */
  resume(...args): boolean {
    validate('resume', [], args);
    const valid =
      this._state === InternalTaskState.PAUSED ||
      this._state === InternalTaskState.PAUSING;
    if (valid) {
      this.transition(InternalTaskState.RUNNING);
    }
    return valid;
  }

  /**
   * This object behaves like a Promise, and resolves with its snapshot data
   * when the upload completes.
   * @param onFulfilled The fulfillment callback. Promise chaining works as normal.
   * @param onRejected The rejection callback.
   */
  then<U>(
    onFulfilled?: ((value) => U | PromiseLike<U>) | null,
    onRejected?: ((error: any) => U | PromiseLike<U>) | null
  ): Promise<U> {
    // These casts are needed so that TypeScript can infer the types of the
    // resulting Promise.
    return this._promise
      .then<U>(onFulfilled as (value) => U | PromiseLike<U>)
      .catch(onRejected as ((error: any) => PromiseLike<never>) | null);
  }
}
