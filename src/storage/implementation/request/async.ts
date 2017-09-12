import { Request, NetworkRequest } from './core';
import * as XhrIoExports from '../xhrio';
import { Headers, XhrIo } from '../xhrio';
import * as type from '../type';
import * as errorsExports from '../error';
import * as backoff from '../backoff';

declare module './core' {
  interface NetworkRequest<T> {
    start_(): void;
    isRetryStatusCode_(status: number): boolean;
    cancel_(appDelete?: boolean);
  }
}

/**
 * A collection of information about the result of a network request.
 * @param opt_canceled Defaults to false.
 * @struct
 */
export class RequestEndStatus {
  /**
   * True if the request was canceled.
   */
  canceled: boolean;

  constructor(
    public wasSuccessCode: boolean,
    public xhr: XhrIo | null,
    opt_canceled?: boolean
  ) {
    this.canceled = !!opt_canceled;
  }
}

Object.assign(NetworkRequest.prototype, {
  start_() {
    let self = this as NetworkRequest<any>;

    function doTheRequest(
      backoffCallback: (p1: boolean, ...p2: any[]) => void,
      canceled: boolean
    ) {
      if (canceled) {
        backoffCallback(false, new RequestEndStatus(false, null, true));
        return;
      }
      let xhr = self.pool_.createXhrIo();
      self.pendingXhr_ = xhr;

      function progressListener(progressEvent: ProgressEvent) {
        let loaded = progressEvent.loaded;
        let total = progressEvent.lengthComputable ? progressEvent.total : -1;
        if (self.progressCallback_ !== null) {
          self.progressCallback_(loaded, total);
        }
      }
      if (self.progressCallback_ !== null) {
        xhr.addUploadProgressListener(progressListener);
      }
      xhr
        .send(self.url_, self.method_, self.body_, self.headers_)
        .then(function(xhr: XhrIo) {
          if (self.progressCallback_ !== null) {
            xhr.removeUploadProgressListener(progressListener);
          }
          self.pendingXhr_ = null;
          xhr = xhr as XhrIo;
          let hitServer =
            xhr.getErrorCode() === XhrIoExports.ErrorCode.NO_ERROR;
          let status = xhr.getStatus();
          if (!hitServer || self.isRetryStatusCode_(status)) {
            let wasCanceled =
              xhr.getErrorCode() === XhrIoExports.ErrorCode.ABORT;
            backoffCallback(
              false,
              new RequestEndStatus(false, null, wasCanceled)
            );
            return;
          }
          let successCode = self.successCodes_.indexOf(status) !== -1;
          backoffCallback(true, new RequestEndStatus(successCode, xhr));
        });
    }

    /**
     * @param requestWentThrough True if the request eventually went
     *     through, false if it hit the retry limit or was canceled.
     */
    function backoffDone(
      requestWentThrough: boolean,
      status: RequestEndStatus
    ) {
      let resolve = self.resolve_ as Function;
      let reject = self.reject_ as Function;
      let xhr = status.xhr as XhrIo;
      if (status.wasSuccessCode) {
        try {
          let result = self.callback_(xhr, xhr.getResponseText());
          if (type.isJustDef(result)) {
            resolve(result);
          } else {
            resolve();
          }
        } catch (e) {
          reject(e);
        }
      } else {
        if (xhr !== null) {
          let err = errorsExports.unknown();
          err.setServerResponseProp(xhr.getResponseText());
          if (self.errorCallback_) {
            reject(self.errorCallback_(xhr, err));
          } else {
            reject(err);
          }
        } else {
          if (status.canceled) {
            let err = self.appDelete_
              ? errorsExports.appDeleted()
              : errorsExports.canceled();
            reject(err);
          } else {
            let err = errorsExports.retryLimitExceeded();
            reject(err);
          }
        }
      }
    }
    if (this.canceled_) {
      backoffDone(false, new RequestEndStatus(false, null, true));
    } else {
      this.backoffId_ = backoff.start(doTheRequest, backoffDone, this.timeout_);
    }
  },
  cancel_(appDelete?: boolean) {
    this.canceled_ = true;
    this.appDelete_ = appDelete || false;
    if (this.backoffId_ !== null) {
      backoff.stop(this.backoffId_);
    }
    if (this.pendingXhr_ !== null) {
      this.pendingXhr_.abort();
    }
  },
  isRetryStatusCode_(status: number): boolean {
    // The codes for which to retry came from this page:
    // https://cloud.google.com/storage/docs/exponential-backoff
    let isFiveHundredCode = status >= 500 && status < 600;
    let extraRetryCodes = [
      // Request Timeout: web server didn't receive full request in time.
      408,
      // Too Many Requests: you're getting rate-limited, basically.
      429
    ];
    let isExtraRetryCode = extraRetryCodes.indexOf(status) !== -1;
    let isRequestSpecificRetryCode =
      this.additionalRetryCodes_.indexOf(status) !== -1;
    return isFiveHundredCode || isExtraRetryCode || isRequestSpecificRetryCode;
  }
});
