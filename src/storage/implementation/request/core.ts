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

/**
 * @fileoverview Defines methods used to actually send HTTP requests from
 * abstract representations.
 */
import { FirebaseStorageError } from '../error';
import * as object from '../object';
import { RequestInfo } from '../requestinfo';
import * as UrlUtils from '../url';
import { Headers, XhrIo } from '../xhrio';
import { XhrIoPool } from '../xhriopool';
import { Deferred } from '../../../utils/promise';
import firebase from '../../../app';

/**
 * @template T
 */
export interface Request<T> {
  getPromise(): Promise<T>;

  /**
   * Cancels the request. IMPORTANT: the promise may still be resolved with an
   * appropriate value (if the request is finished before you call this method,
   * but the promise has not yet been resolved), so don't just assume it will be
   * rejected if you call this function.
   * @param appDelete True if the cancelation came from the app being deleted.
   */
  cancel(appDelete?: boolean): void;
}

export type backoffId = (p1: boolean) => void;

/**
 * @struct
 * @template T
 */
export class NetworkRequest<T> implements Request<T> {
  public url_: string;
  public method_: string;
  public headers_: Headers;
  public body_: string | Blob | Uint8Array | null;
  public successCodes_: number[];
  public additionalRetryCodes_: number[];
  public pendingXhr_: XhrIo | null = null;
  public backoffId_: backoffId | null = null;
  public resolve_: Function | null = null;
  public reject_: Function | null = null;
  public canceled_: boolean = false;
  public appDelete_: boolean = false;
  public callback_: (p1: XhrIo, p2: string) => T;
  public errorCallback_:
    | ((p1: XhrIo, p2: FirebaseStorageError) => FirebaseStorageError)
    | null;
  public progressCallback_: ((p1: number, p2: number) => void) | null;
  public timeout_: number;
  public pool_: XhrIoPool;
  promise_: Promise<T>;

  constructor(
    url: string,
    method: string,
    headers: Headers,
    body: string | Blob | Uint8Array | null,
    successCodes: number[],
    additionalRetryCodes: number[],
    callback: (p1: XhrIo, p2: string) => T,
    errorCallback:
      | ((p1: XhrIo, p2: FirebaseStorageError) => FirebaseStorageError)
      | null,
    timeout: number,
    progressCallback: ((p1: number, p2: number) => void) | null,
    pool: XhrIoPool
  ) {
    this.url_ = url;
    this.method_ = method;
    this.headers_ = headers;
    this.body_ = body;
    this.successCodes_ = successCodes.slice();
    this.additionalRetryCodes_ = additionalRetryCodes.slice();
    this.callback_ = callback;
    this.errorCallback_ = errorCallback;
    this.progressCallback_ = progressCallback;
    this.timeout_ = timeout;
    this.pool_ = pool;
    let self = this;

    /**
     * Fetch the async portions of the API (deferred to optimize 
     * for first load)
     */
    const importAsync = import('./async');

    // Setup Promise Behavior
    const dfd = new Deferred();
    this.promise_ = importAsync.then(() => dfd.promise);
    this.resolve_ = dfd.resolve;
    this.reject_ = dfd.reject;

    this.start();
  }

  /**
   * Actually starts the retry loop.
   */
  async start() {
    await import('./async');
    this.start_();
  }

  /** @inheritDoc */
  getPromise() {
    return this.promise_;
  }

  /** @inheritDoc */
  async cancel(appDelete?: boolean) {
    await import('./async');
    this.cancel_();
  }
}

export function addAuthHeader_(headers: Headers, authToken: string | null) {
  if (authToken !== null && authToken.length > 0) {
    headers['Authorization'] = 'Firebase ' + authToken;
  }
}

export function addVersionHeader_(headers: Headers) {
  let number =
    typeof firebase !== 'undefined' ? firebase.SDK_VERSION : 'AppManager';
  headers['X-Firebase-Storage-Version'] = 'webjs/' + number;
}

/**
 * @template T
 */
export function makeRequest<T>(
  requestInfo: RequestInfo<T>,
  authToken: string | null,
  pool: XhrIoPool
): Request<T> {
  let queryPart = UrlUtils.makeQueryString(requestInfo.urlParams);
  let url = requestInfo.url + queryPart;
  let headers = object.clone<Headers>(requestInfo.headers);
  addAuthHeader_(headers, authToken);
  addVersionHeader_(headers);
  return new NetworkRequest<T>(
    url,
    requestInfo.method,
    headers,
    requestInfo.body,
    requestInfo.successCodes,
    requestInfo.additionalRetryCodes,
    requestInfo.handler,
    requestInfo.errorHandler,
    requestInfo.timeout,
    requestInfo.progressCallback,
    pool
  );
}
