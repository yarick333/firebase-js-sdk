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

// TODO(dimond): The following imports have been replaced with require
// statements to not let the google closure compiler try to resolve them at
// compile time.
// import * as grpc from 'grpc';
// import * as protobufjs from 'protobufjs';
// import * as util from 'util';

import firebase from '@firebase/app';
const SDK_VERSION = firebase.SDK_VERSION;
// Temporary type definition until types work again (see above)
export type GrpcMetadataCallback = any;

// Trick the TS compiler & Google closure compiler into executing normal require
// statements, not using goog.require to import modules at compile time
const dynamicRequire = require;
const grpc = dynamicRequire('grpc');
const grpcVersion = dynamicRequire('grpc/package.json').version;
const util = dynamicRequire('util');

import { Token } from '../api/credentials';
import { DatabaseInfo } from '../core/database_info';
import { Connection, Stream } from '../remote/connection';
import { StreamBridge } from '../remote/stream_bridge';
import { mapCodeFromRpcCode } from '../remote/rpc_error';
import { assert } from '../util/assert';
import { FirestoreError } from '../util/error';
import * as log from '../util/log';
import { AnyJs } from '../util/misc';
import { NodeCallback, nodePromise } from '../util/node_api';
import { ProtobufProtoBuilder } from './load_protos';

const LOG_TAG = 'Connection';

// TODO(b/38203344): The SDK_VERSION is set independently from Firebase because
// we are doing out-of-band releases. Once we release as part of Firebase, we
// should use the Firebase version instead.
const X_GOOG_API_CLIENT_VALUE = `gl-node/${process.versions.node} fire/${
  SDK_VERSION
} grpc/${grpcVersion}`;

function createHeaders(databaseInfo: DatabaseInfo, token: Token | null): {} {
  assert(
    token === null || token.type === 'OAuth',
    'If provided, token must be OAuth'
  );

  const channelCredentials = databaseInfo.ssl
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();

  const callCredentials = grpc.credentials.createFromMetadataGenerator(
    (context: { serviceUrl: string }, cb: GrpcMetadataCallback) => {
      const metadata = new grpc.Metadata();
      if (token) {
        for (const header in token.authHeaders) {
          if (token.authHeaders.hasOwnProperty(header)) {
            metadata.set(header, token.authHeaders[header]);
          }
        }
      }
      metadata.set('x-goog-api-client', X_GOOG_API_CLIENT_VALUE);
      // This header is used to improve routing and project isolation by the
      // backend.
      metadata.set(
        'google-cloud-resource-prefix',
        `projects/${databaseInfo.databaseId.projectId}/` +
          `databases/${databaseInfo.databaseId.database}`
      );
      cb(null, metadata);
    }
  );

  return grpc.credentials.combineChannelCredentials(
    channelCredentials,
    callCredentials
  );
}

interface CachedStub {
  // The type of these stubs is dynamically generated by the GRPC runtime
  // from the protocol buffer.
  // tslint:disable-next-line:no-any
  stub: any;

  token: Token | null;
}

/** GRPC errors expose a code property. */
interface GrpcError extends Error {
  code: number;
}

/** GRPC status information. */
interface GrpcStatus {
  code: number;
  details: string;
}

/**
 * A Connection implemented by GRPC-Node.
 */
export class GrpcConnection implements Connection {
  // tslint:disable-next-line:no-any
  private firestore: any;

  // We cache stubs for the most-recently-used token.
  private cachedStub: CachedStub | null = null;

  constructor(
    builder: ProtobufProtoBuilder,
    private databaseInfo: DatabaseInfo
  ) {
    const protos = grpc.loadObject(builder.ns);
    this.firestore = protos.google.firestore.v1beta1;
  }

  private sameToken(tokenA: Token | null, tokenB: Token | null): boolean {
    const valueA = tokenA && tokenA.authHeaders['Authorization'];
    const valueB = tokenB && tokenB.authHeaders['Authorization'];
    return valueA === valueB;
  }

  // tslint:disable-next-line:no-any
  private getStub(token: Token | null): any {
    if (!this.cachedStub || !this.sameToken(this.cachedStub.token, token)) {
      log.debug(LOG_TAG, 'Creating datastore stubs.');
      const credentials = createHeaders(this.databaseInfo, token);
      this.cachedStub = {
        stub: new this.firestore.Firestore(this.databaseInfo.host, credentials),
        token: token
      };
    }
    return this.cachedStub.stub;
  }

  invoke(rpcName: string, request: any, token: Token | null): Promise<any> {
    const stub = this.getStub(token);
    return nodePromise((callback: NodeCallback<AnyJs>) => {
      return stub[rpcName](request, (grpcError?: GrpcError, value?: AnyJs) => {
        if (grpcError) {
          log.debug(
            LOG_TAG,
            'RPC "' +
              rpcName +
              '" failed with error ' +
              JSON.stringify(grpcError)
          );
          callback(
            new FirestoreError(
              mapCodeFromRpcCode(grpcError.code),
              grpcError.message
            )
          );
        } else {
          callback(undefined, value);
        }
      });
    });
  }

  // TODO(mikelehen): This "method" is a monster. Should be refactored.
  openStream(rpcName: string, token: Token | null): Stream<any, any> {
    const stub = this.getStub(token);
    const grpcStream = stub[rpcName]();

    let closed = false;
    let close: (err?: Error) => void;
    let remoteEnded = false;

    const stream = new StreamBridge({
      sendFn: (msg: any) => {
        if (!closed) {
          log.debug(
            LOG_TAG,
            'GRPC stream sending:',
            util.inspect(msg, { depth: 100 })
          );
          try {
            grpcStream.write(msg);
          } catch (e) {
            // This probably means we didn't conform to the proto.  Make sure to
            // log the message we sent.
            log.error(
              LOG_TAG,
              'Failure sending: ',
              util.inspect(msg, { depth: 100 })
            );
            log.error(LOG_TAG, 'Error: ', e);
            throw e;
          }
        } else {
          log.debug(
            LOG_TAG,
            'Not sending because gRPC stream is closed:',
            util.inspect(msg, { depth: 100 })
          );
        }
      },
      closeFn: () => {
        close();
      }
    });

    close = (err?: FirestoreError) => {
      if (!closed) {
        closed = true;
        stream.callOnClose(err);
        grpcStream.end();
      }
    };

    grpcStream.on('data', (msg: {}) => {
      if (!closed) {
        log.debug(
          LOG_TAG,
          'GRPC stream received: ',
          util.inspect(msg, { depth: 100 })
        );
        stream.callOnMessage(msg);
      }
    });

    grpcStream.on('end', () => {
      log.debug(LOG_TAG, 'GRPC stream ended.');
      // The server closed the remote end.  Close our side too (which will
      // trigger the 'finish' event).
      remoteEnded = true;
      grpcStream.end();
    });

    grpcStream.on('finish', () => {
      // This means we've closed the write side of the stream.  We either did
      // this because the StreamBridge was close()ed or because we got an 'end'
      // event from the grpcStream.

      // TODO(mikelehen): This is a hack because of weird grpc-node behavior
      // (https://github.com/grpc/grpc/issues/7705).  The stream may be finished
      // because we called end() because we got an 'end' event because there was
      // an error.  Now that we've called end(), GRPC should deliver the error,
      // but it may take some time (e.g. 700ms). So we delay our close handling
      // in case we receive such an error.
      if (remoteEnded) {
        setTimeout(close, 2500);
      } else {
        close();
      }
    });

    grpcStream.on('error', (grpcError: GrpcError) => {
      log.debug(LOG_TAG, 'GRPC stream error:', grpcError);
      const code = mapCodeFromRpcCode(grpcError.code);
      close(new FirestoreError(code, grpcError.message));
    });

    grpcStream.on('status', (status: GrpcStatus) => {
      if (!closed) {
        log.debug(LOG_TAG, 'GRPC stream received status:', status);
        if (status.code === 0) {
          // all good
        } else {
          const code = mapCodeFromRpcCode(status.code);
          close(new FirestoreError(code, status.details));
        }
      }
    });

    log.debug(LOG_TAG, 'Opening GRPC stream');
    // TODO(dimond): Since grpc has no explicit open status (or does it?) we
    // simulate an onOpen in the next loop after the stream had it's listeners
    // registered
    setTimeout(() => {
      stream.callOnOpen();
    }, 0);

    return stream;
  }
}
