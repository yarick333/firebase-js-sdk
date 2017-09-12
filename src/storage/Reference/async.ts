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

import { Reference } from './core';
import { Metadata } from '../metadata';
import * as requests from '../implementation/requests';
import { validate } from '../implementation/args';
import { getMappings } from '../implementation/metadata';

/**
 * Patch original `Reference` object to have the new 
 * methods that we need
 */
declare module './core' {
  interface Reference {
    _delete(): Promise<void>;
    _getMetadata(): Promise<Metadata>;
    _updateMetadata(): Promise<Metadata>;
  }
}

Object.assign(Reference.prototype, {
  _delete(...args) {
    const self = this as Reference;
    return this.authWrapper.getAuthToken().then(authToken => {
      let requestInfo = requests.deleteObject(self.authWrapper, self.location);
      return self.authWrapper.makeRequest(requestInfo, authToken).getPromise();
    });
  },
  _getMetadata(...args) {
    const self = this as Reference;
    return self.authWrapper.getAuthToken().then(authToken => {
      let requestInfo = requests.getMetadata(
        self.authWrapper,
        self.location,
        getMappings()
      );

      return self.authWrapper.makeRequest(requestInfo, authToken).getPromise();
    });
  },
  _updateMetadata(...args) {
    const self = this as Reference;
    const [metadata] = args as [Metadata];

    return this.authWrapper.getAuthToken().then(authToken => {
      const requestInfo = requests.updateMetadata(
        self.authWrapper,
        self.location,
        metadata,
        getMappings()
      );

      return self.authWrapper.makeRequest(requestInfo, authToken).getPromise();
    });
  }
});
